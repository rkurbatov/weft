// Families: one cell per entity, built on first demand.
// A member nobody watches is a cache entry, not state — it may be dropped.

import { derived } from './graph.ts'
import type { Derived } from './graph.ts'

export interface FamilyOptions<K, T> {
  name?: string
  /** How a key becomes a map key. Required for object keys; numbers and strings work as they are. */
  keyOf?: (key: K) => string
  /** Ceiling on unwatched members. Watched ones are never evicted and do not count against it. */
  max?: number
  equal?: (a: T, b: T) => boolean
}

export interface Family<K, T> {
  /** The cell for this key — the same cell for the same key, while it lives. */
  (key: K): Derived<T>
  readonly name: string
  /** Members currently held, watched and cached alike. */
  readonly size: number
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

function defaultKeyOf<K>(key: K): string {
  const kind = typeof key
  if (kind === 'string' || kind === 'number' || kind === 'boolean' || kind === 'bigint') {
    return `${kind}:${String(key)}`
  }
  throw new TypeError(
    'weft: family needs keyOf for keys that are not string, number, boolean or bigint',
  )
}

export function family<K, T>(
  build: (key: K) => T,
  options: FamilyOptions<K, T> = {},
): Family<K, T> {
  const name = options.name ?? 'family'
  const keyOf = options.keyOf ?? defaultKeyOf<K>
  const max = options.max ?? 1024
  const equal = options.equal

  // Insertion order is the LRU order: re-demanding a member moves it to the end.
  const members = new Map<string, Member<K, T>>()

  const touch = (id: string, member: Member<K, T>): void => {
    members.delete(id)
    members.set(id, member)
  }

  const dropUnwatched = (): number => {
    let dropped = 0
    for (const [id, member] of members) {
      if (members.size - dropped <= max) break
      if (member.cell.observed) continue
      member.cell.dispose()
      members.delete(id)
      dropped++
    }
    return dropped
  }

  const get = (key: K): Derived<T> => {
    const id = keyOf(key)
    const existing = members.get(id)
    if (existing !== undefined) {
      // Reordering costs a delete and an insert on every read; it only earns
      // that while the ceiling is in sight.
      if (members.size >= max) touch(id, existing)
      return existing.cell
    }
    const member: Member<K, T> = {
      key,
      cell: derived(() => build(key), {
        name: `${name}[${id}]`,
        ...(equal ? { equal } : {}),
      }),
    }
    members.set(id, member)
    if (members.size > max) dropUnwatched()
    return member.cell
  }

  const api = get as Family<K, T> & { name: string }
  Object.defineProperties(api, {
    name: { value: name },
    size: { get: () => members.size },
  })

  api.keys = () => [...members.values()].map(m => m.key)
  api.has = (key: K) => members.has(keyOf(key))

  api.evict = (key: K) => {
    const id = keyOf(key)
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
      member.cell.dispose()
      members.delete(id)
      dropped++
    }
    return dropped
  }

  return api
}
