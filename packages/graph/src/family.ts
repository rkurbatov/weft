// Families: one cell per entity, built on first demand.
// A member nobody watches is a cache entry, not state — it may be dropped.

import { derived, engineOf } from './graph.ts'
import type { Derived } from './graph.ts'
import { RELEASE } from './nodes.ts'
import { OBSERVED } from './parts.ts'
import type { Node } from './parts.ts'

export interface FamilyOptions<K, T> {
  name?: string
  /** How a key becomes a map key. Required for object keys; numbers and strings work as they are. */
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
  const kind = typeof key
  if (kind === 'string' || kind === 'number' || kind === 'boolean' || kind === 'bigint') {
    return `${kind}:${String(key)}`
  }
  throw new TypeError(
    'weft: family needs nameOf for keys that are not string, number, boolean or bigint',
  )
}

export function family<K, T>(
  build: (key: K) => T,
  options: FamilyOptions<K, T> = {},
): Family<K, T> {
  const name = options.name ?? 'family'
  const nameOf = options.nameOf ?? defaultNameOf<K>
  const max = options.max ?? 1024
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

    constructor(key: K, id: string, cell: Derived<T>) {
      this.key = key
      this.id = id
      this.cell = cell
    }

    cooled(observed: boolean): void {
      if (observed) {
        chilled.delete(this)
        return
      }
      chilled.add(this)
      if (chilled.size > max) wantTrim(this)
    }
  }

  /** Every member, by key. Identity: the same key is the same cell. */
  const members = new Map<string, Member>()

  /**
   * The cache proper: the members nobody is reading, oldest first.
   *
   * A member enters when it cools and leaves when somebody looks at it, so its
   * age starts at the moment it actually became a cache entry rather than at
   * the moment it was built. Two members with the same history of being
   * watched therefore come out in the same order, whatever housekeeping
   * happened to walk past them meanwhile.
   *
   * It is also what makes a pass reach its fixed point without restarting:
   * letting a member go turns whatever it was holding cold, those land at the
   * tail of this set, and a walk of a set sees what was added during it.
   */
  const chilled = new Set<Member>()

  let trimWanted = false
  let passing = false

  const forget = (member: Member): void => {
    const node: Node = member.cell
    node[OBSERVED] = undefined
    members.delete(member.id)
    chilled.delete(member)
  }

  // The one way a member leaves, for the ceiling, `sweep` and `evict` alike.
  // The cell itself decides whether it can go — watched, or with its formula
  // on the stack, it stays — so the three cannot come to disagree about what
  // is droppable, which is how `evict` came to kill a running computation.
  const drop = (member: Member): boolean => {
    if (!member.cell[RELEASE]()) return false
    forget(member)
    return true
  }

  /**
   * Drop the oldest cold members until no more than `keep` are left.
   *
   * A member that cannot go — its formula is on the stack — is taken out of
   * the walk and put back at the tail afterwards, because a set re-entered
   * during its own iteration would be walked twice.
   */
  const shrinkTo = (keep: number): number => {
    if (chilled.size <= keep) return 0
    passing = true
    let went = 0
    let stuck: Member[] | undefined
    try {
      for (const member of chilled) {
        if (chilled.size <= keep) break
        if (drop(member)) {
          went++
          continue
        }
        chilled.delete(member)
        stuck ??= []
        stuck.push(member)
      }
    } finally {
      if (stuck !== undefined) for (const member of stuck) chilled.add(member)
      passing = false
    }
    return went
  }

  /**
   * Somebody stopped watching a member while the cache was already full. The
   * ceiling is the library's own promise, so it is kept without waiting for
   * the next key to arrive — but not here and now: this runs inside the
   * engine's unlinking, and disposing cells in the middle of that is asking
   * for trouble. One pass, after the graph is quiet.
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
    const existing = members.get(id)
    if (existing !== undefined) {
      // Looked at, so it is not the oldest cache entry any more. Only while the
      // ceiling is in sight: a delete and an insert on every read is pure cost
      // while the cache is half empty, and showed up whole in a scene profile
      // (95ms → 16ms without it). A watched member is not in this set at all,
      // so for it this is one lookup that misses.
      if (chilled.size >= max && chilled.delete(existing)) chilled.add(existing)
      return existing.cell
    }
    // Room is made before the newborn joins, not after: a member that is not
    // yet in the map cannot be chosen as the candidate to drop, and the caller
    // cannot be handed a cell the family disposed on its way out.
    shrinkTo(max - 1)
    const cell = derived(() => build(key), {
      name: `${name}[${id}]`,
      ...(equal ? { equal } : {}),
    })
    const member = new Member(key, id, cell)
    const node: Node = cell
    node[OBSERVED] = member
    members.set(id, member)
    chilled.add(member)
    return cell
  }

  const api = get as Family<K, T> & { name: string }
  Object.defineProperties(api, {
    name: { value: name },
    size: { get: () => members.size },
    watched: { get: () => members.size > chilled.size },
  })

  api.keys = () => [...members.values()].map(m => m.key)
  api.has = (key: K) => members.has(nameOf(key))

  api.evict = (key: K) => {
    const member = members.get(nameOf(key))
    return member !== undefined && drop(member)
  }

  api.sweep = () => shrinkTo(0)

  return api
}
