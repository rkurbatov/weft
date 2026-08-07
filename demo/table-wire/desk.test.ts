// The desk: a window onto a table that lives elsewhere.
//
// What is checked here is what the page claims: scrolling hands out a
// screenful, not a table, and a draft outlives its row leaving the window.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { subscribe } from '#weft'
import { until } from '#testkit'
import { desk } from './state.ts'

describe('a window onto a big table', () => {
  test('only the visible rows are handed out', () => {
    const held = desk(10_000)
    until(() => held.rows.dispose())
    until(subscribe(held.window, () => {}))

    assert.equal(held.size.peek(), 10_000)
    assert.equal(held.window.peek().length, 20, 'a screenful, whatever the table')
    assert.equal(held.window.peek()[0]?.id, 0)

    held.from.set(5_000)
    assert.equal(held.window.peek()[0]?.id, 5_000, 'the window moved')
    assert.equal(held.window.peek().length, 20)
  })

  test('scrolling costs a screenful, not a table', () => {
    const held = desk(10_000)
    until(() => held.rows.dispose())
    until(subscribe(held.window, () => {}))

    const before = held.crossed.peek()
    for (let at = 0; at < 20; at++) held.from.set(at * 20)
    const spent = held.crossed.peek() - before

    // Twenty scrolls of twenty rows: four hundred, not two hundred thousand.
    assert.ok(spent <= 20 * 20 + 20, `${String(spent)} rows crossed`)
  })

  test('a draft outlives its row leaving the window', () => {
    const held = desk(10_000)
    until(() => held.rows.dispose())
    until(subscribe(held.window, () => {}))

    held.draft(3).set('half typed')
    // The row scrolls far out of sight, and back.
    held.from.set(5_000)
    assert.equal(
      held.window.peek().some(row => row.id === 3),
      false,
      'row 3 is gone from view',
    )
    held.from.set(0)

    assert.equal(held.draft(3).peek(), 'half typed', 'the draft is still here')
  })

  test('an edit reaches the table, and the window shows it', () => {
    const held = desk(1_000)
    until(() => held.rows.dispose())
    until(subscribe(held.window, () => {}))

    const row = held.rows.row(4).peek()
    assert.ok(row !== undefined)
    held.rows.put({ ...row, title: 'renamed' })

    assert.equal(held.window.peek().find(r => r.id === 4)?.title, 'renamed')
  })
})

describe('building a desk of a hundred thousand rows', () => {
  // What is NOT checked here: that the rows go in without being spread into
  // call arguments. `put(...rows)` overflows the stack at this size in a
  // browser and not in Node, so a test here would stay green while the page
  // died on load. It is a browser scene instead, and a rule beside the code.
  test('the window shows a screenful of them', () => {
    const held = desk(100_000)
    until(() => held.rows.dispose())
    until(subscribe(held.window, () => {}))

    assert.equal(held.size.peek(), 100_000)
    assert.equal(held.window.peek().length, 20)
    assert.ok(held.crossed.peek() > 0, 'and the counting happened')
  })
})
