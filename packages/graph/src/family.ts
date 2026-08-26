// Families: one cell per entity, built on first demand.
// A member nobody watches is a cache entry, not state — it may be dropped.

import { derived } from './graph.ts'
import type { Derived } from './graph.ts'
import { RELEASE, WATCHING } from './nodes.ts'

export interface FamilyOptions<K, T> {
  name?: string
  /** How a key becomes a map key. Required for object keys; numbers and strings work as they are. */
  nameOf?: (key: K) => string
  /**
   * Ceiling on unwatched members. Watched ones are never dropped and never
   * counted against it.
   *
   * Checked when a new member is admitted, and only then. Two kinds of member
   * are passed over at that moment even though nobody is watching them: the
   * one being handed to the caller, and one whose own formula is on the stack
   * — a family whose members read each other is building through both. They
   * are ordinary candidates again at the next admission, and `sweep()` drops
   * everything unwatched on the spot. So a family can stand over its ceiling
   * between admissions; at `max: 0`, where every member is one too many, that
   * is the normal state rather than the exception.
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

interface Member<K, T> {
  readonly key: K
  readonly cell: Derived<T>
}

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

  // Insertion order is the age order the ceiling goes by: re-demanding a member
  // moves it to the end, and so does standing in the way of an eviction pass.
  const members = new Map<string, Member<K, T>>()

  // How many members nobody is reading — exactly what the ceiling bounds, held
  // as a number because the map cannot be asked cheaply and guessing it from
  // the order of the walk got the answer wrong: with the cold members standing
  // ahead of the watched ones, a single admission emptied a full cache. The
  // graph says so instead, at the two moments it changes.
  let cold = 0
  const noteWatched = (watched: boolean): void => {
    cold += watched ? -1 : 1
  }

  const touch = (id: string, member: Member<K, T>): void => {
    members.delete(id)
    members.set(id, member)
  }

  // The one way a member leaves, for the ceiling, `sweep` and `evict` alike.
  // The cell itself decides whether it can go — watched, or with its formula
  // on the stack, it stays — so the three cannot come to disagree about what
  // is droppable, which is how `evict` came to kill a running computation.
  const drop = (id: string, member: Member<K, T>): boolean => {
    if (!member.cell[RELEASE]()) return false
    member.cell[WATCHING](undefined)
    members.delete(id)
    cold--
    return true
  }

  // Called just before a new member joins, which is one more that nobody is
  // reading yet. A member the walk cannot drop is passed over for free — it was
  // never counted against the ceiling — and then moved behind the ones it can,
  // or the walk would meet the same standing members on every admission: with
  // two thousand watched members ahead of the cache that was thirty
  // microseconds an admission against one. Moved after the walk, not during
  // it: a key re-inserted into a map under iteration is visited a second time.
  const makeRoom = (): void => {
    let over = cold + 1 - max
    if (over <= 0) return // the common path: not even the iterator is made
    let passed: [string, Member<K, T>][] | undefined
    for (const entry of members) {
      if (over <= 0) break
      if (drop(entry[0], entry[1])) {
        over--
        continue
      }
      members.delete(entry[0])
      passed ??= []
      passed.push(entry)
    }
    if (passed !== undefined) for (const [id, member] of passed) members.set(id, member)
  }

  const get = (key: K): Derived<T> => {
    const id = nameOf(key)
    const existing = members.get(id)
    if (existing !== undefined) {
      // Reordering costs a delete and an insert on every read; it only earns
      // that while the ceiling is in sight — touching unconditionally showed
      // up whole in a scene profile (95ms → 16ms without it). The trade,
      // named: until the family first fills, reads do not refresh age, so a
      // member born early and read hot can be first out at the first
      // overflow and rebuilt on its next read. One rebuild per such member,
      // once, against a per-read tax forever — and a member anybody actually
      // watches is never evicted at all, whatever its age. The query cache in
      // the remote layer chooses the other way for the opposite reason: a
      // read there is a request over a wire, so the reordering is free beside
      // it.
      if (members.size >= max) touch(id, existing)
      return existing.cell
    }
    // Room is made before the newborn joins, not after: a member that is not
    // yet in the map cannot be chosen as the candidate to drop, and the caller
    // cannot be handed a cell the family disposed on its way out.
    makeRoom()
    const cell = derived(() => build(key), {
      name: `${name}[${id}]`,
      ...(equal ? { equal } : {}),
    })
    cell[WATCHING](noteWatched)
    cold++
    members.set(id, { key, cell })
    return cell
  }

  const api = get as Family<K, T> & { name: string }
  Object.defineProperties(api, {
    name: { value: name },
    size: { get: () => members.size },
    watched: { get: () => members.size > cold },
  })

  api.keys = () => [...members.values()].map(m => m.key)
  api.has = (key: K) => members.has(nameOf(key))

  api.evict = (key: K) => {
    const id = nameOf(key)
    const member = members.get(id)
    return member !== undefined && drop(id, member)
  }

  api.sweep = () => {
    let dropped = 0
    for (const [id, member] of members) if (drop(id, member)) dropped++
    return dropped
  }

  return api
}
