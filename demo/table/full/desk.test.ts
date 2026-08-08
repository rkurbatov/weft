// The desk behind the whole-table page.
//
// The protocol itself is tested in the link package; what is checked here is
// that the page's own moving parts behave: rows arrive, rows change in place,
// and the counters say what happened.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { subscribe } from '#weft'
import { until } from '#testkit'
import { desk } from './state.ts'

describe('a desk that keeps working', () => {
  test('pouring adds rows and counts them', () => {
    const held = desk(10)
    until(held.stop)
    until(subscribe(held.jobs.all, () => {}))

    assert.equal(held.size.peek(), 10)
    assert.equal(held.poured.peek(), 10)

    held.pour(5)
    assert.equal(held.size.peek(), 15)
    assert.equal(held.poured.peek(), 15)
  })

  test('touching changes rows in place, without adding any', () => {
    const held = desk(20)
    until(held.stop)
    until(subscribe(held.jobs.all, () => {}))

    const before = held.size.peek()
    held.touch(10)
    assert.equal(held.size.peek(), before, 'edits are edits, not arrivals')
    assert.ok(held.edited.peek() > 0)
  })

  test('a state moves along its cycle rather than jumping about', () => {
    const held = desk(1)
    until(held.stop)
    until(subscribe(held.jobs.all, () => {}))

    const row = held.jobs.row(0).peek()
    assert.equal(row?.state, 'waiting', 'a new row is waiting')

    held.touch(1)
    const after = held.jobs.row(0).peek()
    assert.equal(after?.state, 'running', 'and then it runs')
  })
})
