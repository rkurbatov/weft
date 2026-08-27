// Families: one cell per entity, built on first demand.
// A member nobody watches is a cache entry, not state — it may be dropped.

import { derived, engineOf, keep } from './graph.ts'
import type { Derived } from './graph.ts'
import { ceiling, nameOfKey } from './cache.ts'
import { RELEASE } from './nodes.ts'

export interface FamilyOptions<K, T> {
  name?: string
  /**
   * How a key becomes the name the family holds it under. Without one,
   * `string | number | boolean | bigint` keys work as they are; anything else
   * needs a name of your own.
   */
  nameOf?: (key: K) => string
  /**
   * Ceiling on cold members — the ones nobody is reading. A member somebody
   * watches is not a cache entry at all: it is never dropped and never counted.
   *
   * The ceiling bounds cold *roots*. A cold member whose formula reads other
   * members holds them as watched, and its own subtree is outside the ceiling
   * until the root goes: letting a root go turns whatever it was holding into
   * cold members in their turn, and the same pass takes them. So `max: 1000`
   * on a family whose members read each other can stand at many times that
   * while the roots are within it.
   *
   * Which cold member goes is second chance, not a full order of time: a
   * member read since the last automatic pass is skipped once, and taken by
   * the pass after that unless it is read again. `evict` and `sweep` ignore
   * this entirely.
   *
   * Kept up at two moments and no others: when a member is admitted, and when
   * one cools with the cache already full — the second as one coalesced pass
   * after the graph is quiet, since the cooling happens inside the engine's
   * own bookkeeping. Two members are passed over even so: the one being handed
   * to the caller, and one whose formula is on the stack. They are ordinary
   * candidates at the next pass, and `sweep()` takes everything cold on the
   * spot. Shrinking *below* the ceiling is nobody's business but the owner's:
   * a screen that closes calls `sweep()`.
   */
  max?: number
  equal?: (a: T, b: T) => boolean
}

export interface Family<K, T> {
  /** The cell for this key — the same cell for the same key, while it lives. */
  (key: K): Derived<T>
  readonly name: string
  /** Members currently held, watched and cached alike. */
  readonly size: number
  /**
   * Is anybody watching any member?
   *
   * Asked by whoever holds the family and has a life of its own to decide —
   * an ordered view deciding whether any window of it is being shown. It is
   * the same count the ceiling goes by, so the answer and the eviction rule
   * cannot drift apart.
   */
  readonly watched: boolean
  /** Members held right now; not a set of keys that ever existed. */
  keys(): K[]
  has(key: K): boolean
  /** Drop one member if nothing is using it. Returns whether it went. */
  evict(key: K): boolean
  /** Drop every member nothing is using. Returns how many went. */
  sweep(): number
}

// A watched member is never dropped: its watchers hold that very cell, and a
// dropped one would leave them deaf. Nothing here breaks that invariant.

function defaultNameOf<K>(key: K): string {
  return nameOfKey(key, 'family', 'nameOf')
}

export function family<K, T>(
  build: (key: K) => T,
  options: FamilyOptions<K, T> = {},
): Family<K, T> {
  const name = options.name ?? 'family'
  const nameOf = options.nameOf ?? defaultNameOf<K>
  const max = ceiling(options.max ?? 1024, 'family')
  const equal = options.equal

  /**
   * What the family holds for one key. A class declared here rather than a
   * record with a listener attached: the method it hands the graph then lives
   * on one prototype instead of being a closure per member.
   */
  class Member {
    // Written out rather than declared in the parameters: node strips types
    // without running them, and parameter properties are not types.
    readonly key: K
    readonly id: string
    readonly cell: Derived<T>
    /**
     * Read since an automatic pass last looked at it. Not protection and not a
     * place in any full order of time: it buys one skip from the next pass and
     * nothing else. `evict` and `sweep` do not look at it at all.
     */
    referenced = false

    constructor(key: K, id: string, cell: Derived<T>) {
      this.key = key
      this.id = id
      this.cell = cell
    }

    observationChanged(observed: boolean): void {
      if (observed) {
        cold.delete(this.id)
        hot.set(this.id, this)
        return
      }
      hot.delete(this.id)
      cold.set(this.id, this)
      if (cold.size > max) wantTrim(this)
    }
  }

  /**
   * The cache proper: members nobody is reading, oldest first.
   *
   * A member enters when it cools and leaves when somebody looks at it, so its
   * age starts at the moment it actually became a cache entry rather than at
   * the moment it was built. Two members with the same history of being read
   * therefore come out in the same order, whatever housekeeping happened to
   * walk past them meanwhile.
   *
   * It is also what makes a pass reach its fixed point without restarting:
   * letting a member go turns whatever it was holding cold, those land at the
   * tail of this map, and a walk of a map sees what was added during it.
   */
  const cold = new Map<string, Member>()

  /**
   * Members somebody is reading. Order means nothing here — they are not cache
   * entries at all. Two maps rather than one map and a set of the cold ones:
   * a member belongs to exactly one of the two states, and saying so with the
   * container is worth more than the identity lookup it costs, because both
   * defects this cache has had were invariants that lived in a comment.
   */
  const hot = new Map<string, Member>()

  let trimWanted = false
  let passing = false

  const forget = (member: Member): void => {
    keep(member.cell, undefined)
    cold.delete(member.id)
    hot.delete(member.id)
  }

  /**
   * The one way a member leaves, for the ceiling, `sweep` and `evict` alike.
   * The cell itself decides whether it can go — read by somebody, or with its
   * formula on the stack, it stays — so the three cannot come to disagree
   * about what is droppable, which is how `evict` came to kill a running
   * computation.
   *
   * The candidate leaves the cold order before the attempt, not after. Letting
   * a cell go unlinks it, that can cool other members, and cooling can start a
   * pass from inside this one: a candidate still standing in the order would
   * be picked a second time and asked to release twice. A refused one is put
   * back by whoever asked.
   */
  const release = (member: Member): boolean => {
    cold.delete(member.id)
    if (!member.cell[RELEASE]()) return false
    forget(member)
    return true
  }

  /**
   * Drop the oldest cold members until no more than `limit` are left, or until
   * none of the ones left can go.
   *
   * `spare` is the replacement policy: an automatic pass gives a member that
   * has been read since the last pass one skip, clearing its bit on the way,
   * so the next pass may take it. An explicit `sweep` sets this false — its
   * whole purpose is to keep nothing, and paying a round for a policy of
   * keeping would be beside the point.
   *
   * A skip does not move anything: the bit is cleared and the walk goes on, so
   * a member that keeps being read keeps being skipped and the order is left
   * alone. Only a member the cell refused leaves the walk, and it comes back
   * at the tail afterwards.
   *
   * Two rounds at most, and the second is what makes the ceiling a promise
   * rather than a hope: after the first every bit it met is cleared, so a set
   * where everything had been read cannot end with everybody spared and the
   * ceiling still broken.
   */
  const shrinkTo = (limit: number, spare = true): number => {
    if (cold.size <= limit) return 0
    passing = true
    let went = 0
    try {
      for (let round = 0; round < 2; round++) {
        let spared = 0
        let stuck: Member[] | undefined
        for (const member of cold.values()) {
          if (cold.size + (stuck?.length ?? 0) <= limit) break
          if (spare && member.referenced) {
            // The skip costs one store and leaves the order alone. Moving a
            // spared member to the tail instead was the obvious thing and the
            // expensive one: with half a million members all read, one
            // admission became a million map operations and half a second.
            member.referenced = false
            spared++
            continue
          }
          if (release(member)) {
            went++
            continue
          }
          // Refused, so it left the cold order on the way in and comes back
          // at the tail after the walk: a map re-entered during its own
          // iteration is walked twice.
          stuck ??= []
          stuck.push(member)
        }
        if (stuck !== undefined) for (const member of stuck) cold.set(member.id, member)
        if (spared === 0 || cold.size <= limit) break
      }
    } finally {
      passing = false
    }
    return went
  }

  /**
   * Somebody stopped reading a member while the cache was already full. The
   * ceiling is the library's own promise, so it is kept without waiting for
   * the next key to arrive — but not here and now: this runs inside the
   * engine's unlinking, and disposing cells in the middle of that is asking
   * for trouble. One pass, once the graph is quiet.
   */
  const wantTrim = (member: Member): void => {
    if (trimWanted || passing) return
    const core = engineOf(member.cell)
    if (core === undefined) return
    trimWanted = true
    core.notice(() => {
      trimWanted = false
      shrinkTo(max)
    })
  }

  const get = (key: K): Derived<T> => {
    const id = nameOf(key)
    const chilled = cold.get(id)
    if (chilled !== undefined) {
      // Read, so the next pass owes it one skip. A bit rather than moving it
      // down the order: taking a member out of a map and putting it back cost
      // a scene 95ms against 16ms, and it cost that on every read while the
      // ceiling was in sight. This costs one store, always, and the moving
      // happens only under real pressure — where the old rule did it anyway.
      //
      // What it buys is an order that remembers reads made below the ceiling
      // too. Under the old rule a member read while the cache was half empty
      // was still the oldest thing in it, and went first at the first
      // overflow — which is not what "looked at" ought to mean.
      chilled.referenced = true
      return chilled.cell
    }
    // The cold map is asked first because the scenes with the most reads by far
    // — a sheet, a fold over blocks — hold nothing warm at all.
    const warm = hot.get(id)
    if (warm !== undefined) return warm.cell
    // Room is made before the newborn joins, not after: a member that is not
    // yet in the map cannot be chosen as the candidate to drop, and the caller
    // cannot be handed a cell the family disposed on its way out.
    shrinkTo(max - 1)
    const cell = derived(() => build(key), {
      name: `${name}[${id}]`,
      ...(equal ? { equal } : {}),
    })
    const member = new Member(key, id, cell)
    keep(cell, member)
    cold.set(id, member)
    return cell
  }

  const api = get as Family<K, T> & { name: string }
  Object.defineProperties(api, {
    name: { value: name },
    size: { get: () => cold.size + hot.size },
    watched: { get: () => hot.size > 0 },
  })

  // Held right now, in no promised order: the cache order is not a public fact,
  // and the only way to see it is by which member is evicted first.
  api.keys = () => [...cold.values(), ...hot.values()].map(m => m.key)
  api.has = (key: K) => {
    const id = nameOf(key)
    return cold.has(id) || hot.has(id)
  }

  api.evict = (key: K) => {
    // A member somebody is reading is not in the cold map at all, and that is
    // the whole of the answer: it is not the family's to drop.
    const member = cold.get(nameOf(key))
    if (member === undefined) return false
    if (release(member)) return true
    cold.set(member.id, member)
    return false
  }

  api.sweep = () => shrinkTo(0, false)

  return api
}
