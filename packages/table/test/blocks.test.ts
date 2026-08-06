// Blocks must change the price of an answer, never the answer.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { blocks, derived, port, watch } from '#weft'
import type { Port } from '#weft'
import { until } from '#testkit'

describe('block trees', () => {
  /** A line of numbers as cells, plus a count of how many were read. */
  function numbers(size: number): {
    at: (i: number) => Port<number>
    read: (line: string, i: number) => number
    reads: () => number
    resetReads: () => void
  } {
    const cells = new Map<number, Port<number>>()
    let reads = 0
    const at = (i: number): Port<number> => {
      let box = cells.get(i)
      if (box === undefined) {
        box = port(i < size ? i + 1 : 0, { name: `n${i}` })
        cells.set(i, box)
      }
      return box
    }
    return {
      at,
      read: (_line, i) => {
        reads++
        return at(i).get()
      },
      reads: () => reads,
      resetReads: () => {
        reads = 0
      },
    }
  }

  const sums = (size: number, span = 4) => {
    const source = numbers(size)
    const tree = blocks<number>({
      read: source.read,
      zero: 0,
      join: (a, b) => a + b,
      span,
      name: 'sum',
    })
    return { source, tree }
  }

  test('the answer is the plain answer, aligned or not', () => {
    const { tree } = sums(100)
    const total = (from: number, to: number): number => {
      let n = 0
      for (let i = from; i <= to; i++) n += i + 1
      return n
    }
    assert.equal(tree.range('c', 0, 63), total(0, 63)) // whole blocks
    assert.equal(tree.range('c', 3, 61), total(3, 61)) // ragged both ends
    assert.equal(tree.range('c', 7, 7), total(7, 7)) // one element
    assert.equal(tree.range('c', 8, 4), 0) // empty range is the zero
  })

  test('an edit touches one partial per level, not the whole line', async () => {
    const { source, tree } = sums(4096, 32)
    const total = derived(() => tree.range('c', 0, 4095), { name: 'total' })
    const answer: number[] = []
    until(watch(() => answer.push(total.get())))
    const first = answer.at(-1) as number
    assert.equal(first, (4096 * 4097) / 2)

    source.resetReads()
    source.at(0).set(1000)
    await Promise.resolve()

    assert.equal(answer.at(-1), first + 999)
    // Level 0 block of 32 is the only one re-read; the levels above join partials.
    assert.equal(source.reads(), 32)
  })

  test('nobody watching, nobody working: partials are built on demand only', () => {
    const { source, tree } = sums(1000, 32)
    assert.equal(tree.worked(), 0)
    assert.equal(source.reads(), 0)
    tree.range('c', 0, 31)
    assert.ok(tree.worked() > 0)
  })

  test('lines are separate trees under one name', () => {
    const rows = new Map<string, number[]>([
      ['a', [1, 2, 3, 4, 5, 6, 7, 8]],
      ['b', [10, 20, 30, 40, 50, 60, 70, 80]],
    ])
    const tree = blocks<number>({
      read: (which, i) => rows.get(which)?.[i] ?? 0,
      zero: 0,
      join: (a, b) => a + b,
      span: 4,
      name: 'rows',
    })
    assert.equal(tree.range('a', 0, 7), 36)
    assert.equal(tree.range('b', 0, 7), 360)
    assert.equal(tree.range('b', 4, 7), 260)
  })

  test('the caller decides the join: least, greatest, and text all fold', () => {
    const values = [5, 3, 9, 1, 7, 2, 8, 4]
    const least = blocks<number>({
      read: (_l, i) => values[i] ?? Number.POSITIVE_INFINITY,
      zero: Number.POSITIVE_INFINITY,
      join: Math.min,
      span: 2,
      name: 'least',
    })
    assert.equal(least.range('v', 0, 7), 1)
    assert.equal(least.range('v', 4, 5), 2)

    const words = ['a', 'b', 'c', 'd']
    const joined = blocks<string>({
      read: (_l, i) => words[i] ?? '',
      zero: '',
      join: (a, b) => a + b,
      span: 2,
      name: 'words',
    })
    assert.equal(joined.range('w', 0, 3), 'abcd')
  })
})
