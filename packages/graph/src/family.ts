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
   * Which cold member goes is CLOCK second chance. The cold members stand in a
   * ring in the order they cooled and a hand stands at one of them. A pass
   * walks forward from the hand: a member read since the hand last passed it
   * is passed over once, with its mark cleared, and goes to the pass that
   * reaches it again unless it was read once more. A read moves nothing — the
   * mark is one store — so a whole working set being read again costs no
   * bookkeeping at all.
   *
   * The hand is what makes that cheap in the long run: it stays where the last
   * pass left it, so what it has already judged is not judged again until it
   * comes round. Not because the walk was long — it was a couple of steps per
   * admission either way. A pass that began at the oldest built a fresh
   * `values()` over `cold` every time, and a map whose head keeps being deleted
   * makes each new iterator cross the slots already deleted before it reaches a
   * live one. Constant work per admission, quadratic time, minutes on half a
   * million members.
   *
   * Whatever joins the ring — a newborn, a member that just cooled, one that
   * refused to go — stands *behind* the hand, and so is not judged in the turn
   * it arrived in. A turn is bounded by the size of the ring when it began,
   * which is what makes that true and what keeps a cascade of freed members
   * from spinning the hand. `evict` and `sweep` ignore the marks entirely.
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
     * Read since the hand last passed it. Not protection and not a place in
     * any order of time: it buys one pass-over and nothing else. `evict` and
     * `sweep` do not look at it at all.
     */
    referenced = false
    /**
     * Neighbours in the cold ring, both undefined exactly while the member is
     * out of it. Links on the member rather than an order kept beside it: the
     * ring is entered and left at arbitrary points, and finding a member's
     * place in anything else is the walk this policy exists to avoid.
     */
    previous: Member | undefined = undefined
    next: Member | undefined = undefined

    constructor(key: K, id: string, cell: Derived<T>) {
      this.key = key
      this.id = id
      this.cell = cell
    }

    observationChanged(observed: boolean): void {
      // The credit belongs to one cold lifetime and crosses neither border: a
      // read from an earlier cold life must not buy a pass-over after a whole
      // spell of being read, which cooling has already answered by putting the
      // member behind the hand.
      this.referenced = false
      if (observed) {
        leaveCold(this)
        hot.set(this.id, this)
        return
      }
      hot.delete(this.id)
      enterCold(this)
      if (cold.size > max) wantTrim(this)
    }
  }

  /**
   * The cache proper: every member nobody is reading, found by name. Order is
   * not this map's business but the ring's, so nothing is deleted from it and
   * put back merely to say that a member was read.
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

  /**
   * Where the next pass starts looking, undefined exactly when nothing is
   * cold. It survives between passes: that is the whole of CLOCK, and the
   * reason a scan of a cache at its ceiling costs what it costs.
   */
  let hand: Member | undefined

  let trimWanted = false
  let passing = false

  /**
   * Join the ring immediately behind the hand — the last place it will reach.
   * One door for a newborn, for a member that just cooled and for one that
   * refused to go, because all three mean the same thing here: not this turn's
   * business.
   */
  const enterCold = (member: Member): void => {
    cold.set(member.id, member)
    const at = hand
    if (at === undefined) {
      member.previous = member
      member.next = member
      hand = member
      return
    }
    const back = at.previous as Member
    back.next = member
    member.previous = back
    member.next = at
    at.previous = member
  }

  /** Leave the ring, wherever the hand happens to stand. */
  const leaveCold = (member: Member): void => {
    // Cleared by the member the entry points at, never by name alone: a release
    // that has committed can run other work on its way out, that work can take
    // the same key, and the entry is then the new member's. Deleting by name
    // unmade it and left the ring holding a member the map denied.
    if (cold.get(member.id) === member) cold.delete(member.id)
    const next = member.next
    const previous = member.previous
    if (next === undefined || previous === undefined) return
    if (next === member) {
      hand = undefined
    } else {
      previous.next = next
      next.previous = previous
      // The hand never stands on a member that is gone — whether a pass, an
      // `evict`, a `sweep` or a reader took it out.
      if (hand === member) hand = next
    }
    member.previous = undefined
    member.next = undefined
  }

  const forget = (member: Member): void => {
    keep(member.cell, undefined)
    leaveCold(member)
    if (hot.get(member.id) === member) hot.delete(member.id)
  }

  /**
   * The one way a member leaves, for the ceiling, `sweep` and `evict` alike.
   * The cell itself decides whether it can go — read by somebody, or with its
   * formula on the stack, it stays — so the three cannot come to disagree
   * about what is droppable, which is how `evict` came to kill a running
   * computation.
   *
   * The candidate leaves the ring before the attempt, not after. Letting a
   * cell go unlinks it, that can cool other members, and cooling can start a
   * pass from inside this one: a candidate still standing in the ring would be
   * picked a second time and asked to release twice. A refused one is put back
   * by whoever asked, and its own name is still its own — that is the inert
   * half of the contract at `[RELEASE]`.
   */
  const release = (member: Member): boolean => {
    leaveCold(member)
    if (!member.cell[RELEASE]()) return false
    forget(member)
    return true
  }

  /**
   * One turn of the hand: at most as many steps as the ring held when the turn
   * began. That bound is the arrival rule itself — whatever joins during the
   * turn stands behind the hand, and the steps run out before the hand gets
   * there — and it is also what stops a member that refused from being asked
   * twice in one turn.
   */
  const turn = (limit: number, spare: boolean): { went: number; spared: number } => {
    let went = 0
    let spared = 0
    for (let steps = cold.size; steps > 0 && cold.size > limit; steps--) {
      const member = hand
      if (member === undefined) break
      hand = member.next
      if (spare && member.referenced) {
        // The pass-over costs one store and leaves the ring alone. Moving a
        // spared member behind the others instead was the obvious thing and
        // the expensive one: with half a million members all read, one
        // admission became a million map operations and half a second.
        member.referenced = false
        spared++
        continue
      }
      if (release(member)) {
        went++
        continue
      }
      enterCold(member)
    }
    return { went, spared }
  }

  /**
   * Drop cold members until no more than `limit` are left, or until none of
   * the ones left can go.
   *
   * `spare` is the replacement policy: an automatic pass gives a member read
   * since the hand last passed it one pass-over, clearing its mark on the way.
   * An explicit `sweep` sets this false — its whole purpose is to keep
   * nothing, and paying a turn for a policy of keeping would be beside the
   * point.
   *
   * Turns go on while they free members, since freeing one cools whatever it
   * held and those arrive behind the hand. A turn that only spared may be
   * followed by one more, and that second turn is what makes the ceiling a
   * promise rather than a hope: after the first every mark the hand met is
   * down. A turn that neither freed nor spared met nothing but members that
   * refused, and there is nothing further to try.
   */
  const shrinkTo = (limit: number, spare = true): number => {
    if (cold.size <= limit) return 0
    passing = true
    let went = 0
    let mercy = true
    try {
      while (cold.size > limit) {
        const round = turn(limit, spare)
        went += round.went
        if (round.went > 0) continue
        if (round.spared > 0 && mercy) {
          mercy = false
          continue
        }
        break
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
      // Read, so the hand owes it one pass-over. A mark rather than a move:
      // taking a member out of a map and putting it back cost a scene 95ms
      // against 16ms, and it cost that on every read while the ceiling was in
      // sight. This costs one store, always.
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
    // yet in the ring cannot be chosen as the candidate to drop, and the caller
    // cannot be handed a cell the family disposed on its way out.
    shrinkTo(max - 1)
    const cell = derived(() => build(key), {
      name: `${name}[${id}]`,
      ...(equal ? { equal } : {}),
    })
    const member = new Member(key, id, cell)
    keep(cell, member)
    enterCold(member)
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
    enterCold(member)
    return false
  }

  api.sweep = () => shrinkTo(0, false)

  return api
}
