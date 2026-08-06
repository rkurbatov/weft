// Projection: the book laid over the base, with the identity of unchanged
// pieces preserved under the floor.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { port } from '#graph'
import { projected } from '#keep'
import { PRESERVE_LIMIT, preserve } from '#data'
import { forgetNotices, onNotice } from '#data'
import { laneDrop, laneFind, lanePlace } from '#data'
import type { Lanes } from '#data'
import type { Note } from '#keep'
import { laneAppend } from '#data'

const entry = (name: string, args: unknown, state: Note['state'] = 'waiting'): Note => ({
  id: `${name}-${JSON.stringify(args)}`,
  name,
  args,
  at: 0,
  attempts: 0,
  state,
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

test('the projection lays the book over the base in order, skips the stuck, keeps identity', () => {
  const base = port<{ lanes: Lanes }>({ lanes: { todo: ['a', 'b'], doing: [] } })
  const book = port<readonly Note[]>([])
  const visible = projected(base, book, {
    apply: {
      move: (s: { lanes: Lanes }, op: { id: string; into: string; at: number }) => ({
        lanes: lanePlace(s.lanes, op.id, op.into, op.at),
      }),
      drop: (s: { lanes: Lanes }, op: { id: string }) => ({ lanes: laneDrop(s.lanes, op.id) }),
    },
  })

  assert.deepEqual(visible.peek().lanes, { todo: ['a', 'b'], doing: [] })

  book.set([entry('move', { id: 'a', into: 'doing', at: 0 })])
  assert.deepEqual(visible.peek().lanes, { todo: ['b'], doing: ['a'] })

  const before = visible.peek()
  book.set([
    entry('move', { id: 'a', into: 'doing', at: 0 }),
    entry('drop', { id: 'missing' }, 'stuck'), // stuck: not applied
  ])
  assert.equal(visible.peek(), before) // nothing really changed: the very same object

  // A refused note leaves the book; the projection retreats by recomputing.
  book.set([])
  assert.deepEqual(visible.peek().lanes, { todo: ['a', 'b'], doing: [] })
  assert.deepEqual(laneFind(visible.peek().lanes, 'a'), { lane: 'todo', at: 0 })
})

test('preserve is not blind to Map and Set', () => {
  const prev = {
    rows: new Map([
      ['a', { x: 1 }],
      ['b', { y: 2 }],
    ]),
    tags: new Set(['red']),
  }
  const next = {
    rows: new Map([
      ['a', { x: 1 }],
      ['b', { y: 9 }],
    ]),
    tags: new Set(['red']),
  }
  const kept = preserve(prev, next)
  assert.notEqual(kept, prev)
  assert.equal(kept.rows.get('a'), prev.rows.get('a')) // unchanged row: same object
  assert.equal(kept.rows.get('b')?.y, 9)
  assert.equal(kept.tags, prev.tags) // same membership: the very same set

  const same = preserve(prev, {
    rows: new Map([
      ['a', { x: 1 }],
      ['b', { y: 2 }],
    ]),
    tags: new Set(['red']),
  })
  assert.equal(same, prev)
})

describe('the ceiling on keeping identity', () => {
  test('a small collection keeps its unchanged pieces', () => {
    const before = new Map([
      ['a', { n: 1 }],
      ['b', { n: 2 }],
    ])
    const after = new Map([
      ['a', { n: 1 }],
      ['b', { n: 3 }],
    ])
    const kept = preserve(before, after)
    assert.equal(kept.get('a'), before.get('a'), 'untouched: the very same object')
    assert.notEqual(kept.get('b'), before.get('b'))
  })

  test('a collection past the ceiling is handed back whole, and said so', () => {
    const heard: number[] = []
    const stop = onNotice(what => {
      if (what.kind === 'wholesale') heard.push(Number(what.detail?.['size']))
    })

    const size = PRESERVE_LIMIT + 1
    const before = new Map(Array.from({ length: size }, (_, i) => [i, { n: i }]))
    const after = new Map(Array.from({ length: size }, (_, i) => [i, { n: i }]))

    const kept = preserve(before, after)
    assert.equal(kept, after, 'not walked piece by piece')
    assert.deepEqual(heard, [size], 'and the decision is heard, not silent')

    stop()
  })

  test('the ceiling holds for arrays too', () => {
    const before = Array.from({ length: PRESERVE_LIMIT + 1 }, (_, i) => ({ n: i }))
    const after = Array.from({ length: PRESERVE_LIMIT + 1 }, (_, i) => ({ n: i }))
    assert.equal(preserve(before, after), after)
  })

  test('with nobody listening it complains once, not on every redraw', () => {
    forgetNotices()
    const said: string[] = []
    const before = console.warn
    console.warn = (...parts: unknown[]) => said.push(parts.join(' '))
    try {
      const big = Array.from({ length: PRESERVE_LIMIT + 1 }, (_, i) => ({ n: i }))
      for (let i = 0; i < 5; i++) preserve(big.slice(), big.slice())
    } finally {
      console.warn = before
    }
    // Said at most once — and possibly not at all, if an earlier test in this
    // file already used up the one warning of the run.
    assert.ok(said.length <= 1, `said ${said.length} times`)
  })

  test('a caller who knows its own collection sets its own limit', () => {
    const before = new Map([
      ['a', { n: 1 }],
      ['b', { n: 2 }],
    ])
    const after = new Map([
      ['a', { n: 1 }],
      ['b', { n: 2 }],
    ])
    // Two rows, a limit of one: handed back whole.
    assert.equal(preserve(before, after, 1), after)
    // The same two rows under the ordinary limit keep what they had.
    assert.equal(preserve(before, after).get('a'), before.get('a'))
  })
})

describe('arranging by hand', () => {
  test('append puts a subject at the end of a lane, and only in one lane', () => {
    const lanes = { todo: ['a', 'b'], done: ['c'] }
    const after = laneAppend(lanes, 'c', 'todo')
    assert.deepEqual(after['todo'], ['a', 'b', 'c'])
    assert.deepEqual(after['done'], [], 'a subject stands in one place, not two')
  })

  test('appending what is already at the end changes nothing anybody can see', () => {
    const lanes = { todo: ['a', 'b'] }
    assert.deepEqual(laneAppend(lanes, 'b', 'todo')['todo'], ['a', 'b'])
  })
})
