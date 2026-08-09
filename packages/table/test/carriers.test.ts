// Beside the code because it tests the machinery the door hides on purpose:
// thresholds, the traits a plan is made from, and the carriers themselves.
// The planner and the carriers, tested beside the code they belong to: they
// are the library's own machinery — thresholds, traits, the choice between
// implementations — and an application never names them. What a fold answers,
// as opposed to how it keeps the answer, is tested through the public surface
// in test/.

// The planner decides, the carriers do the work, and neither knows the other.
//
// Which is why this file tests them apart: the planner without a single cell,
// the carriers as arithmetic against one shared suite, and only the last part
// puts them together to watch a live collection outgrow its carrier.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { carrierFor, runningCarrier, treeCarrier } from '../src/carriers/index.ts'
import type { FoldCarrier, FoldWork, Rows } from '../src/carriers/index.ts'
import { planFold, planScan, STORED_CARRY_LIMIT, TREE_SPAN, TREE_WORTH_IT } from '../src/plan.ts'
import { onNotice } from '#graph'
import type { Plan } from '../src/plan.ts'
import type { Notice } from '#graph'
import { subscribe, watch } from '#graph'
import { table } from '../src/table.ts'
import type { Change } from '../src/table.ts'
import { held, until } from '#testkit'

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

  test('no inverse over a small one: a oracle is cheaper than the upkeep', () => {
    const plan = planFold('t', { size: TREE_WORTH_IT - 1, hasSub: false, hasJoin: true })
    assert.equal(plan.carrier, 'oracle')
  })

  test('without a join no tree is lawful, however big the collection', () => {
    const plan = planFold('t', { size: 1_000_000, hasSub: false, hasJoin: false })
    assert.equal(plan.carrier, 'oracle')
    assert.throws(
      () => planFold('t', { size: 1_000_000, hasSub: false, hasJoin: false, forced: 'tree' }),
      /needs a join/,
    )
  })

  test('every decision is announced: a choice nobody can see is magic', () => {
    const heard: Plan[] = []
    until(
      onNotice(what => {
        if (what.kind === 'fold-plan') heard.push(what.detail as unknown as Plan)
      }),
    )
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

    test('agrees with a oracle after a hundred random steps', () => {
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
carriesAFold('an honest oracle', () => runningCarrier(walking))

describe('the factory maps a decision to a carrier, and nothing else does', () => {
  test('each name gives the carrier that keeps that cost', () => {
    const rows = over([row(1, 10), row(2, 30)])
    for (const kind of ['running', 'oracle', 'tree'] as const) {
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
    until(
      onNotice(what => {
        if (what.kind === 'fold-plan')
          heard.push({ name: what.where, carrier: String(what.detail?.['carrier']) })
      }),
    )

    // A maximum has no inverse: below the threshold it is a oracle, above it
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

    assert.equal(heard.at(-1)?.carrier, 'oracle', 'an empty table needs nothing clever')

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
    until(
      onNotice(what => {
        if (what.kind === 'fold-plan') heard.push(String(what.detail?.['carrier']))
      }),
    )
    const t = held(table<Row>({ key: r => r.id, name: 'insisted' }))
    const total = t.fold(
      { carrier: 'oracle', zero: 0, add: (acc, r) => acc + r.score, join: (a, b) => a + b },
      'total',
    )
    until(
      watch(() => {
        total.get()
      }),
    )
    for (let i = 0; i < TREE_WORTH_IT + 10; i++) t.put(row(i, 1))
    assert.equal(total.peek(), TREE_WORTH_IT + 10)
    assert.deepEqual(new Set(heard), new Set(['oracle']), 'the passport stands')
  })
})

interface Scored {
  id: number
  group: string
  score: number
}

const scored = (id: number, group: string, score: number): Scored => ({ id, group, score })

/** A table of scored rows, disposed of when the test ends. */
const filled = (): ReturnType<typeof table<Scored>> =>
  held(table<Scored>({ key: r => r.id, name: 'scored' }))

describe('a fold through the table, where the thresholds decide', () => {
  test('a fold names its carrier by rule, and the choice is visible', () => {
    const heard: Array<{ name: string; carrier: string }> = []
    until(
      onNotice(what => {
        if (what.kind === 'fold-plan')
          heard.push({ name: what.where, carrier: String(what.detail?.['carrier']) })
      }),
    )

    const t = filled()
    for (let i = 0; i < TREE_WORTH_IT + 10; i++) t.put(scored(i, 'a', i))

    // An inverse exists: the running accumulator wins regardless of size.
    t.fold(
      {
        zero: 0,
        add: (a: number, r: Scored) => a + r.score,
        sub: (a: number, r: Scored) => a - r.score,
      },
      'total',
    )
    // No inverse, but partials join and the collection is big: a tree.
    t.fold({ zero: 0, add: (a: number, r: Scored) => Math.max(a, r.score), join: Math.max }, 'peak')
    // Forced by hand for tests.
    t.fold(
      {
        zero: 0,
        add: (a: number, r: Scored) => Math.max(a, r.score),
        join: Math.max,
        carrier: 'oracle' as const,
      },
      'peak.slow',
    )

    assert.deepEqual(heard, [
      { name: 'total', carrier: 'running' },
      { name: 'peak', carrier: 'tree' },
      { name: 'peak.slow', carrier: 'oracle' },
    ])
  })
  test('the tree carrier answers like the oracle, and an edit pays one block', () => {
    const t = filled()
    const N = TREE_SPAN * 4
    for (let i = 0; i < N; i++) t.put(scored(i, 'a', i))

    let added = 0
    const spec = {
      zero: 0,
      add: (a: number, r: Scored) => {
        added++
        return Math.max(a, r.score)
      },
      join: Math.max,
    }
    const fast = t.fold({ ...spec, carrier: 'tree' as const }, 'peak.tree')
    const slow = t.fold({ ...spec, carrier: 'oracle' as const }, 'peak.recount')
    until(subscribe(fast, () => {}))
    until(subscribe(slow, () => {}))
    assert.equal(fast.peek(), slow.peek())

    added = 0
    t.put(scored(3, 'a', 999_999))
    assert.equal(fast.peek(), 999_999)
    assert.equal(fast.peek(), slow.peek())
    // The tree recounted its one dirty block; the oracle walked everything.
    assert.ok(added <= TREE_SPAN + N + 4, `added ${added}`)
    assert.ok(added >= N, 'the oracle alone walks the collection')

    t.drop(3) // a hole, not a shift: the same block recounts, answers still agree
    assert.equal(fast.peek(), slow.peek())
  })
})

describe("the planner's one licence", () => {
  test('a named carry is kept whatever the size, because naming it is the what', () => {
    // The line the planner may not cross. A carrier is a way of arriving at the
    // same answer and may change with the size; a named carry is a field the
    // caller's type promises on every row, and dropping it past a limit made a
    // table right in every test and wrong in production the day it grew.
    const small = planScan('small', { size: 10, numeric: true, named: true })
    const huge = planScan('huge', { size: 1_000_000, numeric: true, named: true })

    assert.equal(small.form, 'stored')
    assert.equal(
      huge.form,
      'stored',
      'the field was asked for; the size is not a licence to drop it',
    )
    assert.notEqual(small.carrier, huge.carrier, 'how it is carried is free to differ')
  })

  test('an unnamed carry may be carried however is cheapest', () => {
    // Nothing outside can tell the forms apart when no field was named, so the
    // planner is free — this is the case the licence exists for.
    const small = planScan('small.unnamed', { size: 10, numeric: true, named: false })
    const huge = planScan('huge.unnamed', { size: 1_000_000, numeric: true, named: false })
    assert.equal(small.form, 'asked')
    assert.equal(huge.form, 'asked')
  })

  test('the price of a named carry past the limit is said out loud', () => {
    const said: Notice[] = []
    until(onNotice(note => said.push(note)))
    planScan('loud', { size: STORED_CARRY_LIMIT, numeric: true, named: true })

    const about = said.find(note => note.kind === 'scan-plan')
    assert.equal(about?.level, 'warn', 'a warning, not a note')
    assert.equal(about?.message.includes('rewrites the tail'), true, 'and it says what it costs')
  })
})
