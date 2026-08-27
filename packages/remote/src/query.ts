// A query: one source per key, with the policies stated once for all of them.
// Asking for a key hands back its source; the same key hands back the same
// source, which is what makes two screens asking for the same thing share one
// request. Cancellation is not an operator here: a screen that
// moves to another key stops asking the old one, and a source nobody asks
// goes quiet by itself — the answer for the old key lands in its own cell,
// which nobody is looking at.

import { ceiling, engineOf, keep, nameOfKey } from '#graph'
import { supply, tally } from './supply.ts'
import type { Supply, SupplyPassport } from './supply.ts'
import type { Tally } from './contract.ts'

export interface QueryOptions<K> extends SupplyPassport {
  /**
   * How a key becomes the name a source is held under. Without one,
   * `string | number | boolean | bigint` keys work as they are; anything else —
   * an object, a symbol, a function — needs a name of your own.
   */
  keyOf?: (key: K) => string
  /**
   * Ceiling on unwatched members; watched ones are never dropped and do not
   * count against it. Stated, not defaulted: an unbounded cache must say so.
   *
   * Read, not asked. A cold reader — one watching without asking the source to
   * work, or a formula that read it once and stayed linked — raises no request
   * and still holds the source's identity, because it is waiting to hear from
   * that very source. Handing the next caller a second source for the same key
   * would leave the reader deaf on the old one, and put two states and two
   * requests behind one question.
   *
   * Checked when a new member joins, and again when one cools, so that letting
   * go of readers restores the ceiling without waiting for somebody to ask a
   * new question. A newborn never pays for its own arrival: with `max` above
   * zero an older cold source pays instead, and the cache is inside its ceiling
   * again by the time the call returns. Only at `max: 0` is there nobody older
   * to pay — there the source just handed out is the one allowed exception, and
   * it holds only until the next maintenance pass: an admission, a trim after
   * something cooled, or an `evict`/`sweep`. A newborn is blocked from paying
   * for its own arrival and for nothing longer; once handed over it is an
   * ordinary cache entry like any other.
   *
   * No ceiling at all is said in the word `'unbounded'`, never by a number: a
   * numeric infinity is refused, as is anything that is not a finite, safe,
   * whole count of none or more.
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
  const { keyOf, max: stated, ...perSupply } = options
  const max = stated === 'unbounded' ? stated : ceiling(stated, 'query')
  // One set of counters for the whole family: a panel asks what the question
  // has done, not what the current key has done — and a run called off because
  // the key changed belongs to the family, not to the key that replaced it.
  const shared = tally(`${perSupply.name ?? 'query'}.tally`)
  const nameOf = (key: K): string => keyOf?.(key) ?? nameOfKey(key, 'query', 'keyOf')

  /**
   * What the cache holds for one key. A class so the method the graph is given
   * lives on one prototype rather than in a closure per source.
   */
  class Held {
    readonly name: string
    readonly feed: Supply<T>

    constructor(name: string, feed: Supply<T>) {
      this.name = name
      this.feed = feed
    }

    observationChanged(observed: boolean): void {
      if (observed) {
        cold.delete(this.name)
        hot.set(this.name, this)
        return
      }
      // Its age as a cache entry starts here, at the tail, not at the moment it
      // was built: until now it was not a cache entry at all.
      hot.delete(this.name)
      cold.set(this.name, this)
      wantTrim(this)
    }
  }

  /** Sources nobody is reading, oldest first: the cache proper. */
  const cold = new Map<string, Held>()
  /** Sources somebody is reading. Not cache entries, so their order says nothing. */
  const hot = new Map<string, Held>()
  let trimQueued = false

  const forget = (member: Held): void => {
    // The ear comes off before the source does: a handle the caller kept must
    // not go on reporting to a cache that no longer owns it.
    keep(member.feed.state, undefined)
    cold.delete(member.name)
    hot.delete(member.name)
  }

  /**
   * Drop the oldest cold sources until no more than `limit` are left. Nothing
   * here can refuse to go and nothing cascades — a source is a handle, not a
   * formula with a stack — so one walk is the whole of it.
   */
  const shrinkTo = (limit: number): number => {
    let went = 0
    for (const member of cold.values()) {
      if (cold.size <= limit) break
      forget(member)
      went++
    }
    return went
  }

  /**
   * A reader let go of a source while the cache was already full. Not here and
   * now: this runs inside the engine's unlinking. One callback, and only one —
   * unlike the facet next door this needs no second flag for the intention,
   * because whether a trim is still wanted can be read off `cold` when the
   * callback runs, and a reader who came back has already moved the member out
   * of it.
   */
  const wantTrim = (member: Held): void => {
    if (trimQueued || max === 'unbounded' || cold.size <= max) return
    const core = engineOf(member.feed.state)
    if (core === undefined) return
    trimQueued = true
    core.notice(() => {
      trimQueued = false
      // `max` is a number by here — the guard above returned on 'unbounded' —
      // and whether a trim is still wanted is simply what `cold` says now.
      if (cold.size > max) shrinkTo(max)
    })
  }

  const ask = ((key: K): Supply<T> => {
    const name = nameOf(key)
    const chilled = cold.get(name)
    if (chilled !== undefined) {
      // Freshen its place in the cache order, so eviction drops the coldest.
      //
      // Unconditionally, unlike the cell family next door, which only reorders
      // once its ceiling is in sight. Both are right where they stand and the
      // difference is the cost of a read: asking here means a request over a
      // wire, so a delete and an insert beside it are free — in a family a read
      // is a cached formula on a hot path, and the same pair of operations
      // showed up whole in a profile.
      cold.delete(name)
      cold.set(name, chilled)
      return chilled.feed
    }
    const warm = hot.get(name)
    if (warm !== undefined) return warm.feed
    const feed = supply<T>(asked => load(key, asked), {
      ...perSupply,
      tally: shared,
      name: `${perSupply.name ?? 'query'}:${name}`,
    })
    // Room before the newborn joins: a source handed to the caller that the
    // cache has already let go asks the world twice for one answer.
    if (max !== 'unbounded') shrinkTo(max - 1)
    const member = new Held(name, feed)
    keep(feed.state, member)
    cold.set(name, member)
    return feed
  }) as Query<K, T>

  Object.defineProperty(ask, 'size', { get: () => cold.size + hot.size })
  Object.defineProperty(ask, 'tally', { value: shared })
  ask.evict = key => {
    // A source somebody is reading is not in the cold map at all, and that is
    // the whole of the answer: it is not the cache's to drop.
    const member = cold.get(nameOf(key))
    if (member === undefined) return false
    forget(member)
    return true
  }
  ask.sweep = () => shrinkTo(0)
  return ask
}
