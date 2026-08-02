// Projection: the book laid over the base, with the identity of unchanged
// pieces preserved under the floor.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { input } from '#core/graph.ts'
import { preserve, projected } from '#core/project.ts'
import { laneDrop, laneFind, lanePlace } from '#core/arrange.ts'
import type { Lanes } from '#core/arrange.ts'
import type { Entry } from '#core/outbox.ts'

const entry = (name: string, args: unknown, state: Entry['state'] = 'waiting'): Entry => ({
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
  const base = input<{ lanes: Lanes }>({ lanes: { todo: ['a', 'b'], doing: [] } })
  const book = input<readonly Entry[]>([])
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
