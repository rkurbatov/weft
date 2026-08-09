// A feed: a stream of keyed changes, and what it takes to follow one.
//
// The subject the layers above share. A table produces a feed; the wire ships
// one across a worker boundary as differences; the relational layer reads one
// to keep a tree current; the dialect wraps one for a screen. Four consumers,
// one contract — which is why it is a package and not the inside of the table.
//
// The key lives here for the same reason: "a stream of keyed changes" is the
// definition, and identity is what a feed is organised by. Nothing below this
// package needs it.
//
// Called `contract.ts` and not `types.ts`: what is here is not "the types of
// this package" but the promise its several files implement, and a reader who
// opens it is asking what the promise is. A file named for the kind of its
// contents collects everything of that kind — the options of one adapter next
// to the words four packages speak — and stops answering that question.
//
// Only the contract and the following machinery are here. Producing a feed —
// holding the rows, deciding who wins when two writers bring the same row — is
// the table's work, and stays there.

import type { Watchable } from '#graph'

export type Key = string | number

/** One key's move: insert (no prev), update (both sides), removal (no next). */
export interface Change<R> {
  key: Key
  prev?: R
  next?: R
}

// What a derived thing needs from what it follows. State reads are only valid
// after reading version: the read is what brings the follower up to date.
export interface Feed<R> {
  readonly name: string
  readonly version: Watchable<number>
  keyOf(row: R): Key
  get(key: Key): R | undefined
  each(fn: (row: R) => void): void
  count(): number
  /**
   * The rows as the map they already are, read-only and live.
   *
   * For a consumer that needs the whole collection at once — a relational
   * rebuild, a served snapshot. Walking `each` into a fresh map copied a
   * hundred thousand entries to hand over what the table was holding in
   * exactly that shape; the reference is live, so take it for a synchronous
   * look and copy only what outlives the call.
   */
  asMap(): ReadonlyMap<Key, R>
  /** Changes after the given version, or null when they are no longer remembered. */
  changesSince(v: number): Change<R>[] | null
}

export interface Follower<R> {
  first(): void
  apply(changes: readonly Change<R>[]): void
  resync(): void
}
