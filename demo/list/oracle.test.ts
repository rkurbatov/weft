// Both layouts must answer the same, or the comparison means nothing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classicList } from './classic.ts'
import { weftList } from './weft.ts'

function heights(count: number): number[] {
  const out: number[] = []
  let seed = 7
  for (let i = 0; i < count; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    out.push(24 + (seed % 200))
  }
  return out
}

test('offsets and hit-testing agree, before and after measuring', () => {
  const rows = heights(3000)
  const a = classicList(rows)
  const b = weftList(rows)

  for (const i of [0, 1, 511, 512, 513, 1500, 2999]) {
    assert.equal(b.offsetOf(i), a.offsetOf(i), `offset of ${i}`)
  }

  a.measure(700, 400)
  b.measure(700, 400)
  a.measure(2048, 30)
  b.measure(2048, 30)

  for (const i of [699, 700, 701, 2047, 2048, 2999]) {
    assert.equal(b.offsetOf(i), a.offsetOf(i), `offset of ${i} after measuring`)
  }

  const total = a.offsetOf(2999)
  for (const p of [0, 1, 100, Math.floor(total / 3), total - 1]) {
    assert.deepEqual(b.at(p), a.at(p), `hit test at ${p}`)
  }
})

test('rows fed in on top move everything below by the same amount', () => {
  const rows = heights(2000)
  const a = classicList(rows)
  const b = weftList(rows)
  const before = a.offsetOf(1000)

  const fresh = heights(100)
  const added = fresh.reduce((x, y) => x + y, 0)
  a.prepend(fresh)
  b.prepend(fresh)

  assert.equal(a.offsetOf(1100), before + added)
  assert.equal(b.offsetOf(1100), before + added)
  assert.equal(b.size(), a.size())
})
