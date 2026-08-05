// What a carrier of a fold is.
//
// A fold has one answer and several ways to keep it: a running accumulator, an
// honest oracle, a tree of block partials. They differ in who pays for one
// edit and in nothing else — the answer is the same, and that is what makes
// swapping one for another lawful.
//
// The interface exists so that the choice can be made elsewhere (the planner),
// tested apart from the graph, and changed while the collection is alive.

import type { Change, Key } from '../table.ts'

export interface FoldWork<R, A> {
  zero: A
  add(acc: A, row: R): A
  join?: (a: A, b: A) => A
  sub?(acc: A, row: R): A
}

/** The rows a carrier is built over: whatever it needs, and nothing more. */
export interface Rows<R> {
  each(fn: (row: R) => void): void
  keyOf(row: R): Key
  count(): number
}

export interface FoldCarrier<R, A> {
  /** The answer as it stands. Cheap: a read may not walk the collection. */
  answer(): A
  /** Build from nothing over the rows given. */
  rebuild(rows: Rows<R>): void
  /** Take one batch of changes. */
  feed(changes: readonly Change<R>[], rows: Rows<R>): void
}
