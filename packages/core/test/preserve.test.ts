// Structural sharing: what the layers above buy from the machine room.
//
// The promise is one line — a piece that did not change stays the same object,
// so a screen that re-renders on identity does not re-render — and everything
// below is the price of keeping it honest on real values.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { preserve } from '#core'

describe('bulk data through preserve', () => {
  test('a typed array is handed on whole', () => {
    const before = new Float64Array(1_000_000).map((_, i) => i)
    const after = before.slice()

    const started = performance.now()
    const kept = preserve(before, after)
    const spent = performance.now() - started

    // There is nothing inside a buffer whose identity could be kept, so the
    // new one is the answer — and arriving at that answer costs nothing.
    assert.equal(kept, after)
    assert.ok(spent < 50, `preserving took ${spent.toFixed(0)}ms`)
  })

  test('a buffer inside an object does not cost the object its identity', () => {
    const bulk = new Float64Array(100_000)
    const before = { hist: bulk, at: 1 }
    const after = { hist: bulk, at: 1 }
    const kept = preserve(before, after)
    assert.equal(kept, before, 'nothing changed, so nothing was replaced')
  })
})

test('preserve: a date that moved is a new value, a date that did not keeps its identity', () => {
  // A date has no enumerable keys, so the object walk saw two empty shapes
  // and handed the OLD date back whenever only a timestamp changed.
  const was = new Date(1000)
  assert.equal(preserve(was, new Date(1000)), was)
  const moved = new Date(2000)
  assert.equal(preserve(was, moved), moved)
  const prev = { id: 1, at: new Date(1000) }
  const next = { id: 1, at: new Date(2000) }
  const kept = preserve(prev, next)
  assert.notEqual(kept, prev)
  assert.equal(kept.at, next.at)
  assert.equal(preserve(prev, { id: 1, at: new Date(1000) }), prev)
})
test('preserve: an error that changed its story is a new value', () => {
  const was = new Error('no')
  assert.equal(preserve(was, new Error('no')), was)
  const worse = new Error('still no')
  assert.equal(preserve(was, worse), worse)
  const kept = preserve({ id: 1, fault: was }, { id: 1, fault: new Error('still no') })
  assert.equal((kept as { fault: Error }).fault.message, 'still no')
})
test('preserve: a value with a cycle is walked, not crashed on', () => {
  // Cycles survive structured cloning, so they are legal in a kept value —
  // and the sibling walk in `alike` already learned this lesson.
  interface Loop {
    n: number
    self?: Loop
  }
  const a: Loop = { n: 1 }
  a.self = a
  const b: Loop = { n: 2 }
  b.self = b
  const kept = preserve(a, b)
  assert.equal(kept.n, 2, 'the new value made it through')
  const same: Loop = { n: 1 }
  same.self = same
  assert.equal(preserve(a, same).n, 1)
})
test('preserve: a key the old object lacked is a change even when it holds undefined', () => {
  // Absence and `undefined` read the same through an index — so a schema
  // change swapping one key for another used to hand the OLD object back.
  const prev = { y: 1 } as Record<string, unknown>
  const next = { x: undefined } as Record<string, unknown>
  const kept = preserve(prev, next)
  assert.notEqual(kept, prev)
  assert.equal('x' in kept, true)
  assert.equal('y' in kept, false)
})
test('preserve: a map entry the old map lacked is a change even when it holds undefined', () => {
  const prev = new Map<string, unknown>([['y', 1]])
  const next = new Map<string, unknown>([['x', undefined]])
  const kept = preserve(prev, next)
  assert.notEqual(kept, prev)
  assert.equal(kept.has('x'), true)
  assert.equal(kept.has('y'), false)
})
test('preserve: an unchanged piece keeps being the very same object', () => {
  const prev = { a: { x: 1 }, list: [1, 2, 3], b: { y: 2 } }
  const next = { a: { x: 1 }, list: [1, 2, 3], b: { y: 99 } }
  const kept = preserve(prev, next)
  assert.notEqual(kept, prev) // the whole did change
  assert.equal(kept.a, prev.a) // the untouched piece did not
  assert.equal(kept.list, prev.list)
  assert.equal(kept.b.y, 99)
  assert.equal(preserve(prev, { a: { x: 1 }, list: [1, 2, 3], b: { y: 2 } }), prev)
})
