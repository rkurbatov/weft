// Families: one cell per entity, built on first demand.
// A member nobody watches is a cache entry, not state — it may be dropped.

import { derived } from './graph.ts'
import type { Derived } from './graph.ts'

export interface FamilyOptions<K, T> {
  name?: string
  /** How a key becomes a map key. Required for object keys; numbers and strings work as they are. */
  nameOf?: (key: K) => string
  /**
   * Ceiling on unwatched members. Watched ones are never evicted and do not
   * count against it. One member may stand over the ceiling: the one just
   * asked for, which is held until the next key is asked for.
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
   * the same `observed` the ceiling goes by, so the answer and the eviction
   * rule cannot drift apart.
   */
  readonly watched: boolean
  /** Members held right now; not a set of keys that ever existed. */
  keys(): K[]
  has(key: K): boolean
  /** Drop one member if nothing watches it. Returns whether it went. */
  evict(key: K): boolean
  /** Drop every unwatched member. Returns how many went. */
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

  // Insertion order is the LRU order: re-demanding a member moves it to the end.
  const members = new Map<string, Member<K, T>>()

  const touch = (id: string, member: Member<K, T>): void => {
    members.delete(id)
    members.set(id, member)
  }

  // Called just before a new member joins; `over` is how many held members are
  // one too many once it does. Every member the walk passes costs one from that
  // budget — a dropped one because it is gone, a watched one because it never
  // counted against the ceiling — so the walk is bounded by the budget, not the
  // map: `watched + 1` steps once the family is full. The error is one-sided: a
  // watched member met before the cold ones behind it spends a drop's budget,
  // so the cache can sit under its ceiling, never over it.
  const makeRoom = (): void => {
    let over = members.size + 1 - max
    if (over <= 0) return // the common path: not even the iterator is made
    for (const [id, member] of members) {
      if (over <= 0) return
      over--
      // `observed`, not `demanded`, and the difference is the invariant at
      // the top of this file: a cold watch — demand off, a journal following
      // what happens anyway — is still a watcher, and dropping the cell
      // under it leaves it deaf. The price is that a formula built and
      // abandoned without a subscribe pins its members here; that is the
      // documented anti-pattern the React seam is shaped to avoid (see
      // useLive: the screen cell is born on subscription, never in render).
      if (member.cell.observed) continue
      // A member whose own formula is running is in use as surely as a watched
      // one: it is usually the very build that asked for the key now arriving
      // (a fold over blocks, a tree of parts). Dropping it throws, and the run
      // that was building it dies.
      if (member.cell.computing) continue
      member.cell.dispose()
      members.delete(id)
    }
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
    const member: Member<K, T> = {
      key,
      cell: derived(() => build(key), {
        name: `${name}[${id}]`,
        ...(equal ? { equal } : {}),
      }),
    }
    members.set(id, member)
    return member.cell
  }

  const api = get as Family<K, T> & { name: string }
  Object.defineProperties(api, {
    name: { value: name },
    size: { get: () => members.size },
    watched: {
      get: () => {
        for (const member of members.values()) if (member.cell.observed) return true
        return false
      },
    },
  })

  api.keys = () => [...members.values()].map(m => m.key)
  api.has = (key: K) => members.has(nameOf(key))

  api.evict = (key: K) => {
    const id = nameOf(key)
    const member = members.get(id)
    if (member === undefined || member.cell.observed) return false
    member.cell.dispose()
    members.delete(id)
    return true
  }

  api.sweep = () => {
    let dropped = 0
    for (const [id, member] of members) {
      if (member.cell.observed) continue
      // A member whose own formula is running is in use as surely as a watched
      // one: it is usually the very build that asked for the key now arriving
      // (a fold over blocks, a tree of parts). Dropping it throws, and the run
      // that was building it dies.
      if (member.cell.computing) continue
      member.cell.dispose()
      members.delete(id)
      dropped++
    }
    return dropped
  }

  return api
}
