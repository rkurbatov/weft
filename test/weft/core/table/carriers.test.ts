// The planner decides, the carriers do the work, and neither knows the other.
//
// Which is why this file tests them apart: the planner without a single cell,
// the carriers as arithmetic against one shared suite, and only the last part
// puts them together to watch a live collection outgrow its carrier.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { carrierFor, runningCarrier, treeCarrier } from '#weft/core/table/carriers/index.ts'
import type { FoldCarrier, FoldWork, Rows } from '#weft/core/table/carriers/index.ts'
import { onPlan, planFold, TREE_WORTH_IT } from '#weft/core/table/plan.ts'
import type { Plan } from '#weft/core/table/plan.ts'
import { watch } from '#weft/core/graph/graph.ts'
import { table } from '#weft/core/table/table.ts'
import type { Change } from '#weft/core/table/table.ts'
import { held, until } from '../../../kit/index.ts'

interface Row {
  id: number
  score: number
}

const row = (id: number, score: number): Row => ({ id, score })

/** The rows a carrier is built over, made by hand: no table, no graph. */
function over(rows: Row[]): Rows<Row> {
  return {
    each: fn => {
      for (const r of rows) fn(r)
    },
    keyOf: r => r.id,
    count: () => rows.length,
  }
}

const summing: FoldWork<Row, number> = {
  zero: 0,
  add: (acc, r) => acc + r.score,
  sub: (acc, r) => acc - r.score,
  join: (a, b) => a + b,
}

const highest: FoldWork<Row, number> = {
  zero: Number.NEGATIVE_INFINITY,
  add: (acc, r) => Math.max(acc, r.score),
  join: (a, b) => Math.max(a, b),
}

describe('the planner, without a graph in sight', () => {
  test('an inverse wins over everything: one edit is one add and one sub', () => {
    const plan = planFold('t', { size: 100_000, hasSub: true, hasJoin: true })
    assert.equal(plan.carrier, 'running')
    assert.match(plan.reason, /inverse/)
  })

  test('no inverse over a big collection: a tree, so one edit costs one block', () => {
    const plan = planFold('t', { size: TREE_WORTH_IT, hasSub: false, hasJoin: true })
    assert.equal(plan.carrier, 'tree')
  })

  test('no inverse over a small one: a recount is cheaper than the upkeep', () => {
    const plan = planFold('t', { size: TREE_WORTH_IT - 1, hasSub: false, hasJoin: true })
    assert.equal(plan.carrier, 'recount')
  })

  test('without a join no tree is lawful, however big the collection', () => {
    const plan = planFold('t', { size: 1_000_000, hasSub: false, hasJoin: false })
    assert.equal(plan.carrier, 'recount')
    assert.throws(
      () => planFold('t', { size: 1_000_000, hasSub: false, hasJoin: false, forced: 'tree' }),
      /needs a join/,
    )
  })

  test('every decision is announced: a choice nobody can see is magic', () => {
    const heard: Plan[] = []
    until(onPlan((_name, plan) => heard.push(plan)))
    planFold('takings', { size: 10, hasSub: true, hasJoin: true })
    assert.equal(heard.length, 1)
    assert.equal(heard[0]?.carrier, 'running')
  })
})

/**
 * One suite, run against every carrier. They differ in who pays for an edit
 * and in nothing else — so any answer that differs is a bug, whichever carrier
 * gave it.
 */
function carriesAFold(name: string, make: () => FoldCarrier<Row, number>): void {
  describe(`${name} as a carrier of a sum`, () => {
    test('answers over nothing, and over what it was built on', () => {
      const carrier = make()
      carrier.rebuild(over([]))
      assert.equal(carrier.answer(), 0)
      carrier.rebuild(over([row(1, 10), row(2, 30)]))
      assert.equal(carrier.answer(), 40)
    })

    test('takes an addition, an edit and a removal', () => {
      const rows = [row(1, 10), row(2, 30)]
      const carrier = make()
      carrier.rebuild(over(rows))

      rows.push(row(3, 2))
      carrier.feed([{ key: 3, next: row(3, 2) }], over(rows))
      assert.equal(carrier.answer(), 42)

      rows[0] = row(1, 11)
      carrier.feed([{ key: 1, prev: row(1, 10), next: row(1, 11) }], over(rows))
      assert.equal(carrier.answer(), 43)

      rows.splice(1, 1)
      carrier.feed([{ key: 2, prev: row(2, 30) }], over(rows))
      assert.equal(carrier.answer(), 13)
    })

    test('agrees with a recount after a hundred random steps', () => {
      let seed = 7
      const random = (): number => {
        seed = (seed * 1664525 + 1013904223) >>> 0
        return seed / 2 ** 32
      }
      const rows: Row[] = []
      const carrier = make()
      carrier.rebuild(over(rows))

      for (let step = 0; step < 100; step++) {
        const id = Math.floor(random() * 20)
        const at = rows.findIndex(r => r.id === id)
        const changes: Change<Row>[] = []
        if (at >= 0 && random() < 0.3) {
          changes.push({ key: id, prev: rows[at] as Row })
          rows.splice(at, 1)
        } else {
          const next = row(id, Math.floor(random() * 100))
          if (at >= 0) {
            changes.push({ key: id, prev: rows[at] as Row, next })
            rows[at] = next
          } else {
            changes.push({ key: id, next })
            rows.push(next)
          }
        }
        carrier.feed(changes, over(rows))
        const honest = rows.reduce((acc, r) => acc + r.score, 0)
        assert.equal(carrier.answer(), honest, `step ${step}`)
      }
    })
  })
}

carriesAFold('a running accumulator', () => runningCarrier(summing))
carriesAFold('a tree of blocks', () => treeCarrier(summing, 4))
// The same carrier with no inverse to lean on: it walks the rows again, and
// must still answer exactly the same.
const walking: FoldWork<Row, number> = {
  zero: 0,
  add: (acc, r) => acc + r.score,
  join: (a, b) => a + b,
}
carriesAFold('an honest recount', () => runningCarrier(walking))

describe('the factory maps a decision to a carrier, and nothing else does', () => {
  test('each name gives the carrier that keeps that cost', () => {
    const rows = over([row(1, 10), row(2, 30)])
    for (const kind of ['running', 'recount', 'tree'] as const) {
      const carrier = carrierFor<Row, number>(kind, summing)
      carrier.rebuild(rows)
      assert.equal(carrier.answer(), 40, kind)
    }
  })
})

describe('a tree of blocks, for an operation with no inverse', () => {
  test('keeps a maximum through edits and removals', () => {
    const rows = [row(1, 10), row(2, 50), row(3, 20)]
    const carrier = treeCarrier(highest, 2)
    carrier.rebuild(over(rows))
    assert.equal(carrier.answer(), 50)

    rows[1] = row(2, 5)
    carrier.feed([{ key: 2, prev: row(2, 50), next: row(2, 5) }], over(rows))
    assert.equal(carrier.answer(), 20)

    rows.push(row(4, 100))
    carrier.feed([{ key: 4, next: row(4, 100) }], over(rows))
    assert.equal(carrier.answer(), 100)
  })
})

describe('a fold re-planned as its collection grows', () => {
  test('the carrier is swapped, the swap is announced, the answer never lies', () => {
    const heard: Array<{ name: string; carrier: string }> = []
    until(onPlan((name, plan) => heard.push({ name, carrier: plan.carrier })))

    // A maximum has no inverse: below the threshold it is a recount, above it
    // a tree — and a table usually starts empty and fills up afterwards.
    const t = held(table<Row>({ key: r => r.id, name: 'takings' }))
    const top = t.fold(
      { zero: Number.NEGATIVE_INFINITY, add: (acc, r) => Math.max(acc, r.score), join: Math.max },
      'top',
    )
    until(
      watch(() => {
        top.get()
      }),
    )

    assert.equal(heard.at(-1)?.carrier, 'recount', 'an empty table needs nothing clever')

    for (let i = 0; i < TREE_WORTH_IT + 10; i++) t.put(row(i, i))
    assert.equal(top.peek(), TREE_WORTH_IT + 9)
    assert.equal(heard.at(-1)?.carrier, 'tree', 'it grew, so the plan changed with it')

    // And the answer stays right across the swap, edit by edit.
    t.put(row(5, 10_000))
    assert.equal(top.peek(), 10_000)
    t.drop(5)
    assert.equal(top.peek(), TREE_WORTH_IT + 9)
  })

  test('a carrier named by hand is never taken away', () => {
    const heard: string[] = []
    until(onPlan((_name, plan) => heard.push(plan.carrier)))
    const t = held(table<Row>({ key: r => r.id, name: 'insisted' }))
    const total = t.fold(
      { carrier: 'recount', zero: 0, add: (acc, r) => acc + r.score, join: (a, b) => a + b },
      'total',
    )
    until(
      watch(() => {
        total.get()
      }),
    )
    for (let i = 0; i < TREE_WORTH_IT + 10; i++) t.put(row(i, 1))
    assert.equal(total.peek(), TREE_WORTH_IT + 10)
    assert.deepEqual(new Set(heard), new Set(['recount']), 'the passport stands')
  })
})
