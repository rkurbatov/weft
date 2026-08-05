// What every runner is: a thing that takes the changes of one input and says
// what changed at its own level, or rebuilds itself from scratch when it has
// fallen too far behind. Each operation's runner lives in its own file beside
// this one; only the orchestrator knows which is which.

import type { Change, Key } from '../../table/table.ts'
import type { Row } from '../expr.ts'
import type { RelNode } from '../node.ts'

export type Sources = Record<string, ReadonlyMap<Key, Row>>

/** What an ordered pass can answer without writing a number into any row. */
export interface Ordering {
  /** The carry before the row at this place. */
  offsetAt(place: number): number
  /** The carry before this row, or null when it is not in the pass. */
  offsetOf(key: Key): number | null
  /** Which place a point falls in, and how far into it. */
  at(point: number): { place: number; key: Key; into: number } | null
  /** The row standing at this place. */
  keyAt(place: number): Key | null
  placeOf(key: Key): number | null
  /** The whole pass's extent. */
  extent(): number
  size(): number
}

/** One node, running: state where the derivative needs it. */
export interface Runner {
  /** Changes from one source pushed through; out come this node's changes. */
  feed(from: string, changes: readonly Change<Row>[]): Change<Row>[]
  /** The whole answer anew; resets whatever state the node keeps. */
  rebuild(sources: Sources): Map<Key, Row>
  /** A scan's ordered view: the carry answered on demand, whatever the form. */
  view?: Ordering
}

/** How a runner asks for the runner of its own input, without knowing the tree. */
export type Make = (node: RelNode) => Runner

export const diffInto = (
  out: Map<Key, Change<Row>>,
  before: Map<Key, Row>,
  after: Map<Key, Row>,
): void => {
  const land = (key: Key, prev: Row | undefined, next: Row | undefined): void => {
    const held = out.get(key)
    const first = held === undefined ? prev : held.prev
    out.set(key, {
      key,
      ...(first === undefined ? {} : { prev: first }),
      ...(next === undefined ? {} : { next }),
    })
  }
  for (const [key, prev] of before) if (!after.has(key)) land(key, prev, undefined)
  for (const [key, next] of after) land(key, before.get(key), next)
}
