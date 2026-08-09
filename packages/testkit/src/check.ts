// Checks in the words of the thing being checked.
//
// `assert.deepEqual(live.all.peek().map(r => r.id), [2])` says how to look
// before it says what is expected. These say what is expected.

import assert from 'node:assert/strict'
import { subscribe } from '#graph'
import type { Watchable } from '#graph'
import { until } from './lifetime.ts'

interface Peekable<T> {
  peek(): T
}

interface Keyed {
  id: unknown
}

type Rows<R> = Peekable<readonly R[]> | { all: Peekable<readonly R[]> }

function rowsOf<R>(source: Rows<R>): readonly R[] {
  return 'peek' in source ? source.peek() : source.all.peek()
}

/** The rows, by id, in order. */
export function hasIds<R extends Keyed>(source: Rows<R>, expected: unknown[], why?: string): void {
  assert.deepEqual(
    rowsOf(source).map(row => row.id),
    expected,
    why ?? 'rows by id',
  )
}

/** What a cell holds right now, without waking anything. */
export function holds<T>(cell: Peekable<T>, expected: T, why?: string): void {
  assert.deepEqual(cell.peek(), expected, why ?? 'held value')
}

/**
 * A counter of wakings, for the question this library is really about: did
 * this change cost anybody a redraw?
 */
export function wakings(): {
  count(): number
  note(): void
  is(expected: number, why?: string): void
} {
  let seen = 0
  return {
    count: () => seen,
    note: () => {
      seen++
    },
    is: (expected, why) => assert.equal(seen, expected, why ?? 'wakings'),
  }
}

/**
 * Follow a cell for the length of the test, keeping what it said.
 *
 * The shape it replaces, written by hand in every second reactivity test:
 * `const seen = []; until(subscribe(cell, v => seen.push(v)))`. The
 * subscription is registered for cleanup here, so a failing assertion cannot
 * leave a live watcher behind.
 */
export function track<T, V = T>(
  cell: Watchable<T>,
  of?: (value: T) => V,
): {
  /** Everything the cell said since tracking began, in order. */
  values(): readonly V[]
  last(): V | undefined
  count(): number
  /** The record so far equals this, in order. */
  said(expected: readonly V[], why?: string): void
} {
  const seen: V[] = []
  // What to keep, when the whole value is not what the test is about: the
  // kind of an answer rather than the answer, an id rather than a row. Kept
  // rather than mapped at the assertion, so the record reads as the question.
  const keep = of ?? ((value: T): V => value as unknown as V)
  until(subscribe(cell, value => seen.push(keep(value))))
  return {
    values: () => seen,
    last: () => seen.at(-1),
    count: () => seen.length,
    said: (expected, why) => assert.deepEqual(seen, expected, why ?? 'values seen'),
  }
}
