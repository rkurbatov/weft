// A query: one source per key, with the policies stated once for all of them.
// Asking for a key hands back its source; the same key hands back the same
// source, which is what makes two screens asking for the same thing share one
// request. Cancellation is not an operator here: a screen that
// moves to another key stops watching the old one, and a source nobody watches
// goes quiet by itself — the answer for the old key lands in its own cell,
// which nobody is looking at.

import { source } from './source.ts'
import type { Source, SourceOptions } from './source.ts'

export interface QueryOptions<K> extends SourceOptions {
  /** How a key becomes a map key. Required for object keys. */
  keyOf?: (key: K) => string
  /**
   * Ceiling on unwatched members; watched ones are never dropped and do not
   * count against it. Stated, not defaulted: an unbounded cache must say so.
   */
  max: number | 'unbounded'
}

export interface Query<K, T> {
  /** The source for this key — the same one for the same key, while it lives. */
  (key: K): Source<T>
  readonly size: number
  /** Drop one unwatched member. Returns whether it went. */
  evict(key: K): boolean
  /** Drop every unwatched member. Returns how many went. */
  sweep(): number
}

export function query<K, T>(load: (key: K) => Promise<T>, options: QueryOptions<K>): Query<K, T> {
  const { keyOf, max, ...perSource } = options
  const held = new Map<string, { key: K; feed: Source<T> }>()

  const nameOf = (key: K): string => {
    if (keyOf !== undefined) return keyOf(key)
    const kind = typeof key
    if (kind === 'string' || kind === 'number' || kind === 'boolean' || kind === 'bigint') {
      return String(key)
    }
    throw new Error(`weft: query needs keyOf for ${kind} keys`)
  }

  /** Unwatched members past the ceiling go, oldest first; watched ones stay. */
  const makeRoom = (): void => {
    if (max === 'unbounded') return
    let unwatched = 0
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

  const ask = ((key: K): Source<T> => {
    const name = nameOf(key)
    const known = held.get(name)
    if (known !== undefined) {
      // Freshen its place in insertion order, so eviction drops the coldest.
      held.delete(name)
      held.set(name, known)
      return known.feed
    }
    const feed = source(() => load(key), {
      ...perSource,
      name: `${perSource.name ?? 'query'}:${name}`,
    })
    held.set(name, { key, feed })
    makeRoom()
    return feed
  }) as Query<K, T>

  Object.defineProperty(ask, 'size', { get: () => held.size })
  ask.evict = key => {
    const name = nameOf(key)
    const member = held.get(name)
    if (member === undefined || member.feed.demanded) return false
    held.delete(name)
    return true
  }
  ask.sweep = () => {
    let went = 0
    for (const [name, member] of [...held]) {
      if (member.feed.demanded) continue
      held.delete(name)
      went++
    }
    return went
  }
  return ask
}
