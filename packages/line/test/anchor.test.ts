// Holding a row in place: the arithmetic, without a browser in sight.
//
// This used to live inside a React hook, where it could only be tested by
// rendering a list and reading a scroll position. It is arithmetic on a line;
// here it is tested as arithmetic.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { anchorShift } from '#line'
import type { Key } from '#feed'

describe('anchoring a moving line', () => {
  const standing = (places: Record<string, number>) => (key: Key) => places[String(key)] ?? -1

  test('a row that moved down carries the box with it', () => {
    const move = anchorShift({ key: 'a', rank: 10 }, standing({ a: 14 }), 28)
    assert.deepEqual(move, { by: 4 * 28, rank: 14 })
  })

  test('a row that moved up scrolls the box back', () => {
    const move = anchorShift({ key: 'a', rank: 10 }, standing({ a: 7 }), 28)
    assert.deepEqual(move, { by: -3 * 28, rank: 7 })
  })

  test('a row that stayed put asks for nothing', () => {
    assert.equal(anchorShift({ key: 'a', rank: 10 }, standing({ a: 10 }), 28), null)
  })

  test('a row that left the view asks for nothing either', () => {
    // Below zero means gone: there is nothing to hold on to, and guessing a
    // shift here would move the screen away from what the reader is seeing.
    assert.equal(anchorShift({ key: 'a', rank: 10 }, standing({}), 28), null)
  })
})
