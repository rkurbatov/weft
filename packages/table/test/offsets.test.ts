import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { offsets } from '#weft'

describe('the measured line', () => {
  const naive = (sizes: number[]) => ({
    offsetOf: (index: number) => sizes.slice(0, index).reduce((a, b) => a + b, 0),
    total: () => sizes.reduce((a, b) => a + b, 0),
    at(point: number) {
      let sum = 0
      for (let i = 0; i < sizes.length; i++) {
        const next = sum + (sizes[i] as number)
        if (point < next || i === sizes.length - 1) return { index: i, into: point - sum }
        sum = next
      }
      return { index: -1, into: point }
    },
  })

  test('oracle: every answer equals a oracle, through measures, inserts and removals', () => {
    const sizes = [48, 96, 48, 320, 48, 48, 96]
    const line = offsets(sizes)

    const check = (): void => {
      const truth = naive(sizes)
      assert.equal(line.size(), sizes.length)
      assert.equal(line.total(), truth.total())
      for (let i = 0; i <= sizes.length; i++) assert.equal(line.offsetOf(i), truth.offsetOf(i))
      for (const point of [0, 47, 48, 200, truth.total() - 1, truth.total() + 500]) {
        assert.deepEqual(line.at(point), truth.at(point))
      }
    }

    check()
    line.measure(3, 96)
    sizes[3] = 96
    check()
    line.insert(0, [96, 96])
    sizes.unshift(96, 96)
    check()
    line.insert(4, [320])
    sizes.splice(4, 0, 320)
    check()
    line.remove(1, 3)
    sizes.splice(1, 3)
    check()
    line.measure(0, 12)
    sizes[0] = 12
    check()
    line.replace([48, 48])
    sizes.length = 0
    sizes.push(48, 48)
    check()
  })

  test('a burst of insertions costs one rebuild, at the first question', () => {
    const line = offsets(Array.from({ length: 10_000 }, () => 48))
    line.total() // built
    line.resetWorked()

    for (let i = 0; i < 5; i++)
      line.insert(
        0,
        Array.from({ length: 100 }, () => 96),
      )
    line.measure(2, 320) // lands while stale, carried by the same rebuild
    assert.equal(line.worked(), 0, 'nothing is rebuilt until someone asks')

    const size = line.size()
    assert.equal(line.offsetOf(1), 96)
    assert.equal(line.worked(), size, 'the first question pays for one rebuild of the line')

    line.resetWorked()
    assert.equal(line.at(0).index, 0)
    assert.equal(line.worked(), 0, 'the next question rides the same tree')
  })

  test('a measurement on a settled line touches log n, not the line', () => {
    const line = offsets(Array.from({ length: 100_000 }, () => 48))
    const before = line.total()
    line.resetWorked()
    line.measure(20, 320)
    assert.ok(line.worked() <= 32, `walked ${line.worked()}`)
    assert.equal(line.total(), before + 320 - 48)
  })

  test('an empty line and late reports answer honestly', () => {
    const line = offsets()
    assert.equal(line.size(), 0)
    assert.equal(line.total(), 0)
    assert.deepEqual(line.at(100), { index: -1, into: 100 })

    line.insert(0, [48])
    line.remove(0)
    line.measure(0, 96) // the row already left — screens report late
    assert.equal(line.total(), 0)
  })

  test('rows arriving one at a time do not cost the square of the line', () => {
    // A streaming list: rows land one by one. The old insert copied the whole
    // line each time, which is quadratic — and on fifty thousand rows that was
    // fifteen seconds of the main thread rather than milliseconds.
    const line = offsets([])
    const started = performance.now()
    for (let i = 0; i < 20_000; i++) line.insert(i, [20])
    const spent = performance.now() - started

    assert.equal(line.offsetOf(19_999), 19_999 * 20, 'and the answers are right')
    assert.ok(spent < 2000, `twenty thousand insertions took ${spent.toFixed(0)}ms`)
  })

  test('rows landing at the end do not retire the tree', () => {
    // The streaming case: a row arrives, the screen asks where things are,
    // repeat. A full rebuild per arrival made appending as expensive as
    // prepending — on two hundred thousand rows, a second per two hundred rows.
    const line = offsets(Array.from({ length: 20_000 }, () => 20))
    line.offsetOf(19_999)
    line.resetWorked()

    for (let i = 0; i < 200; i++) {
      line.insert(line.size(), [20])
      line.at(1234)
    }

    // Work done is per arrival, not per row of the line.
    assert.ok(line.worked() < 20_000, `worked ${line.worked()} times`)
    assert.equal(line.total(), 20_200 * 20, 'and the answers are still right')
    assert.equal(line.offsetOf(20_100), 20_100 * 20)
  })
})
