import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subscribe } from '#core/graph.ts'
import { table } from '#core/table.ts'
import type { SourceTable } from '#core/table.ts'

interface Row {
  id: number
  group: string
  score: number
}

const row = (id: number, group: string, score: number): Row => ({ id, group, score })

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

test('a put equal to what is there is not a change: nothing wakes, the row stays itself', () => {
  const t = table<Row>({ key: r => r.id })
  t.put(row(1, 'a', 10), row(2, 'b', 20))
  const kept = t.peek(1)

  let woke = 0
  const stop = subscribe(t.row(1), () => woke++)
  const stopSize = subscribe(t.size, () => woke++)

  t.put(row(1, 'a', 10)) // a fresh object, same content
  assert.equal(woke, 0)
  assert.equal(t.peek(1), kept)

  t.put(row(1, 'a', 11))
  assert.equal(woke, 1)
  stop()
  stopSize()
})

test('only the touched row wakes', () => {
  const t = table<Row>({ key: r => r.id })
  t.put(row(1, 'a', 10), row(2, 'b', 20))
  let one = 0
  let two = 0
  const stopOne = subscribe(t.row(1), () => one++)
  const stopTwo = subscribe(t.row(2), () => two++)

  t.put(row(1, 'a', 99))
  assert.equal(one, 1)
  assert.equal(two, 0)
  stopOne()
  stopTwo()
})

test('where follows by changes: one edit costs one test, not a rescan', () => {
  const t = table<Row>({ key: r => r.id })
  for (let i = 0; i < 500; i++) t.put(row(i, 'a', i))

  let tested = 0
  const high = t.where(r => {
    tested++
    return r.score >= 250
  })
  const stop = subscribe(high.size, () => {})
  assert.equal(tested, 500) // the first build reads everything once

  tested = 0
  t.put(row(3, 'a', 400))
  assert.equal(tested, 1)
  assert.equal(high.size.peek(), 251)
  stop()
})

test('an edit the filter absorbs stops there: nothing below wakes', () => {
  const t = table<Row>({ key: r => r.id })
  for (let i = 0; i < 20; i++) t.put(row(i, 'a', i))
  const high = t.where(r => r.score >= 100)

  let woke = 0
  const stop = subscribe(high.all, () => woke++)
  t.put(row(5, 'a', 6)) // was out, stays out
  t.drop(7) // was out
  assert.equal(woke, 0)

  t.put(row(5, 'a', 150)) // enters
  assert.equal(woke, 1)
  stop()
})

test('counters move by the edit, not by the count', () => {
  const t = table<Row>({ key: r => r.id })
  for (let i = 0; i < 300; i++) t.put(row(i, i % 2 === 0 ? 'even' : 'odd', i))

  let added = 0
  const total = t.fold({
    zero: 0,
    add: (acc, r) => {
      added++
      return acc + r.score
    },
    sub: (acc, r) => acc - r.score,
  })
  const stop = subscribe(total, () => {})
  assert.equal(added, 300)

  added = 0
  t.put(row(10, 'even', 1000))
  assert.equal(added, 1)
  assert.equal(total.peek(), (299 * 300) / 2 - 10 + 1000)
  stop()
})

test('an ordered window wakes only when the window itself moves', () => {
  const t = table<Row>({ key: r => r.id })
  for (let i = 0; i < 100; i++) t.put(row(i, 'a', i))
  const byScore = t.orderBy((a, b) => b.score - a.score)

  const top = byScore.slice(0, 5)
  let woke = 0
  const stop = subscribe(top, () => woke++)
  assert.deepEqual(
    top.peek().map(r => r.id),
    [99, 98, 97, 96, 95],
  )

  t.put(row(20, 'a', 50)) // moves deep below the window
  assert.equal(woke, 0)

  t.put(row(20, 'a', 1000)) // enters the window at the top
  assert.equal(woke, 1)
  assert.deepEqual(
    top.peek().map(r => r.id),
    [20, 99, 98, 97, 96],
  )
  stop()
})

test('replace keeps untouched rows as the very same objects: a refetch is quiet', () => {
  const t = table<Row>({ key: r => r.id })
  t.put(row(1, 'a', 10), row(2, 'b', 20), row(3, 'c', 30))
  const kept = t.peek(2)

  let woke = 0
  const stops = [1, 2, 3].map(id => subscribe(t.row(id), () => woke++))

  // The server answered again: same content in fresh objects, one row really changed, one gone.
  t.replace([row(1, 'a', 10), row(2, 'b', 21)])
  assert.equal(t.peek(1), t.peek(1))
  assert.equal(woke, 2) // row 2 changed, row 3 left; row 1 slept
  assert.notEqual(t.peek(2), kept)
  assert.equal(t.size.peek(), 2)
  for (const stop of stops) stop()
})

test('a follower past the remembered changes rebuilds once and its own followers stay incremental', () => {
  const t = table<Row>({ key: r => r.id, keep: 4 })
  for (let i = 0; i < 10; i++) t.put(row(i, 'a', i))

  const high = t.where(r => r.score >= 5)
  const count = high.count(r => r.score >= 8)
  assert.equal(count.peek(), 2) // builds both, then both go cold

  // Far more batches than the log remembers.
  for (let i = 0; i < 40; i++) t.put(row(100 + i, 'a', i % 10))
  t.drop(9)

  assert.equal(high.size.peek(), 4 + 20)
  assert.equal(count.peek(), 1 + 8) // one survivor, plus fresh scores 8 and 9, four of each
})

test('oracle: every derived answer equals a recount from scratch, at every step', () => {
  const chance = seeded(7)
  const t = table<Row>({ key: r => r.id, keep: 8 })
  const model = new Map<number, Row>()

  const high = t.where(r => r.score >= 50)
  const evens = high.where(r => r.group === 'even')
  const ordered = t.orderBy((a, b) => a.score - b.score || a.id - b.id)
  const total = t.sumBy(r => r.score)
  const highCount = t.count(r => r.score >= 50)

  const ids = (rows: readonly Row[]): number[] => rows.map(r => r.id).sort((a, b) => a - b)
  const check = (): void => {
    const rows = [...model.values()]
    assert.deepEqual(ids(high.all.peek()), ids(rows.filter(r => r.score >= 50)))
    assert.deepEqual(
      ids(evens.all.peek()),
      ids(rows.filter(r => r.score >= 50 && r.group === 'even')),
    )
    const sorted = [...rows].sort((a, b) => a.score - b.score || a.id - b.id)
    assert.deepEqual(
      ordered
        .slice(0, rows.length)
        .peek()
        .map(r => r.id),
      sorted.map(r => r.id),
    )
    assert.equal(
      total.peek(),
      rows.reduce((acc, r) => acc + r.score, 0),
    )
    assert.equal(highCount.peek(), rows.filter(r => r.score >= 50).length)
  }

  for (let step = 0; step < 300; step++) {
    const roll = chance()
    if (roll < 0.55) {
      const id = Math.floor(chance() * 60)
      const fresh = row(id, chance() < 0.5 ? 'even' : 'odd', Math.floor(chance() * 100))
      t.put(fresh)
      model.set(id, fresh)
    } else if (roll < 0.8) {
      const id = Math.floor(chance() * 60)
      t.drop(id)
      model.delete(id)
    } else if (roll < 0.95) {
      const puts: Row[] = []
      for (let i = 0; i < 5; i++) {
        const id = Math.floor(chance() * 60)
        puts.push(row(id, chance() < 0.5 ? 'even' : 'odd', Math.floor(chance() * 100)))
      }
      const gone = Math.floor(chance() * 60)
      t.apply({ put: puts, drop: [gone] })
      // apply works puts first, drops after; the model mirrors that order
      for (const r of puts) model.set(r.id, r)
      model.delete(gone)
    } else {
      const kept = [...model.values()].filter(() => chance() < 0.7)
      t.replace(kept)
      model.clear()
      for (const r of kept) model.set(r.id, r)
    }
    check()
  }
})
