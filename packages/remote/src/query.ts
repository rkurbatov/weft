// A query: one source per key, with the policies stated once for all of them.
// Asking for a key hands back its source; the same key hands back the same
// source, which is what makes two screens asking for the same thing share one
// request. Cancellation is not an operator here: a screen that
// moves to another key stops watching the old one, and a source nobody watches
// goes quiet by itself — the answer for the old key lands in its own cell,
// which nobody is looking at.

import { supply, tally } from './supply.ts'
import type { Supply, SupplyPassport } from './supply.ts'
import type { Tally } from './contract.ts'

export interface QueryOptions<K> extends SupplyPassport {
  /** How a key becomes a map key. Required for object keys. */
  keyOf?: (key: K) => string
  /**
   * Ceiling on unwatched members; watched ones are never dropped and do not
   * count against it. Stated, not defaulted: an unbounded cache must say so.
   *
   * Checked when a new member joins, and a newborn never pays for its own
   * arrival: with `max` above zero an older cold source pays instead, and the
   * cache is inside its ceiling again by the time the call returns. Only at
   * `max: 0` is there nobody older to pay — there the source just handed out
   * is the one allowed exception, and it goes when a different key arrives.
   */
  max: number | 'unbounded'
}

export interface Query<K, T> {
  /** The source for this key — the same one for the same key, while it lives. */
  (key: K): Supply<T>
  readonly size: number
  /**
   * What the question has done across every key.
   *
   * Of the family, not of the current member: a run called off because the key
   * changed belongs to the question, and the key that replaced it never saw it
   * happen.
   */
  readonly tally: Tally
  /** Drop one unwatched member. Returns whether it went. */
  evict(key: K): boolean
  /** Drop every unwatched member. Returns how many went. */
  sweep(): number
}

export function query<K, T>(
  load: (key: K, asked: { signal: AbortSignal; soFar: (value: T) => void }) => Promise<T>,
  options: QueryOptions<K>,
): Query<K, T> {
  const { keyOf, max, ...perSupply } = options
  // One set of counters for the whole family: a panel asks what the question
  // has done, not what the current key has done — and a run called off because
  // the key changed belongs to the family, not to the key that replaced it.
  const shared = tally(`${perSupply.name ?? 'query'}.tally`)
  const held = new Map<string, { key: K; feed: Supply<T> }>()

  const nameOf = (key: K): string => {
    if (keyOf !== undefined) return keyOf(key)
    const kind = typeof key
    if (kind === 'string' || kind === 'number' || kind === 'boolean' || kind === 'bigint') {
      return String(key)
    }
    throw new Error(`weft: query needs keyOf for ${kind} keys`)
  }

  /**
   * Unwatched members past the ceiling go, oldest first; watched ones stay.
   * Called just before a new member joins, so the newborn counts against the
   * ceiling but cannot be the candidate that pays for it — a caller handed a
   * source the cache has already let go asks the world twice for one answer.
   */
  const makeRoom = (): void => {
    if (max === 'unbounded') return
    let unwatched = 1 // the one about to join: nobody demands it yet
    for (const member of held.values()) if (!member.feed.demanded) unwatched++
    let over = unwatched - max
    if (over <= 0) return
    for (const [name, member] of held) {
      if (over <= 0) return
      if (member.feed.demanded) continue
      held.delete(name)
      over--
    }
  }

  const ask = ((key: K): Supply<T> => {
    const name = nameOf(key)
    const known = held.get(name)
    if (known !== undefined) {
      // Freshen its place in insertion order, so eviction drops the coldest.
      //
      // Unconditionally, unlike the cell family next door, which only
      // reorders once its ceiling is in sight. Both are right where they
      // stand and the difference is the cost of a read: asking here means a
      // request over a wire, so a delete and an insert beside it are free —
      // in a family a read is a cached formula on a hot path, and the same
      // pair of operations showed up whole in a profile. Named in both
      // places so neither reads as an oversight.
      held.delete(name)
      held.set(name, known)
      return known.feed
    }
    const feed = supply<T>(asked => load(key, asked), {
      ...perSupply,
      tally: shared,
      name: `${perSupply.name ?? 'query'}:${name}`,
    })
    makeRoom()
    held.set(name, { key, feed })
    return feed
  }) as Query<K, T>

  Object.defineProperty(ask, 'size', { get: () => held.size })
  Object.defineProperty(ask, 'tally', { value: shared })
  ask.evict = key => {
    const name = nameOf(key)
    const member = held.get(name)
    if (member === undefined || member.feed.demanded) return false
    held.delete(name)
    return true
  }
  ask.sweep = () => {
    let went = 0
    // Snapshot: eviction deletes from `held` while we walk it.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const [name, member] of [...held]) {
      if (member.feed.demanded) continue
      held.delete(name)
      went++
    }
    return went
  }
  return ask
}