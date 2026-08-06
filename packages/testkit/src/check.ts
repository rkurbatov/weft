// Checks in the words of the thing being checked.
//
// `assert.deepEqual(live.all.peek().map(r => r.id), [2])` says how to look
// before it says what is expected. These say what is expected.

import assert from 'node:assert/strict'

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
