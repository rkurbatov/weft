import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { barHeights } from './bars.ts'

describe('histogram heights', () => {
  test('the tallest bucket reaches the top', () => {
    const bars = barHeights([1, 10, 100])
    assert.equal(bars.heights.at(-1), 100)
    assert.equal(bars.most, 100)
  })

  test('equal ratios are equal steps down the page', () => {
    const bars = barHeights([100, 1_000, 10_000])
    const [small, middle, large] = bars.heights
    const stepOne = (middle ?? 0) - (small ?? 0)
    const stepTwo = (large ?? 0) - (middle ?? 0)
    assert.ok(Math.abs(stepOne - stepTwo) <= 3, 'a tenfold drop is always the same distance')
  })

  test('a real latency shape keeps its form and its tail', () => {
    // The numbers from the page: a first bucket forty times the last, and a
    // bump where everything over two seconds piles up.
    const bars = barHeights([22_804, 7_327, 2_222, 1_008, 559, 2_644])
    assert.equal(bars.heights[0], 100, 'the busiest bucket reaches the top')
    const tail = bars.heights[4] ?? 0
    assert.ok(tail >= 4 && tail < 30, `the thinnest bucket is ${String(tail)}% — short, but there`)
    assert.ok((bars.heights[5] ?? 0) > tail + 20, 'and the bump over two seconds stands out')
    assert.ok((bars.heights[1] ?? 0) < 90, 'the shape has not collapsed into a flat wall')
  })

  test('an empty bucket stays empty', () => {
    // "Few" and "none" must never look the same.
    const bars = barHeights([0, 1, 1000])
    assert.equal(bars.heights[0], 0)
    assert.ok((bars.heights[1] ?? 0) >= 2)
  })

  test('an empty histogram is flat, and keeps its shape', () => {
    const bars = barHeights(new Float64Array(20))
    assert.equal(bars.heights.length, 20)
    assert.equal(bars.most, 0)
  })
})
