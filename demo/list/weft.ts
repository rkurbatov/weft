// The same list, laid out by the library: a row's height is a cell, and the
// sum above it is a block tree over those cells.
//
// Nothing is cached and nothing is invalidated. A height that changes touches
// one partial per level; the next question is answered from partials that are
// still good. Rows added on top move every index, but nothing is thrown away —
// the tree simply grows.

import { blocks, stored } from '#weft'
import type { Stored } from '#weft'

export interface List {
  offsetOf(index: number): number
  at(pixel: number): { index: number; into: number }
  measure(index: number, height: number): void
  prepend(heights: readonly number[]): void
  size(): number
  walked(): number
  resetWalked(): void
}

export function weftList(heights: number[]): List {
  let rows: Stored<number>[] = heights.map((h, i) => stored(h, { name: `h${i}` }))

  const tree = blocks<number>({
    name: 'height',
    span: 512,
    zero: 0,
    join: (a, b) => a + b,
    read: (_line, at) => rows[at]?.get() ?? 0,
    max: 1_000_000,
  })

  const above = (index: number): number => (index <= 0 ? 0 : tree.range('h', 0, index - 1))

  return {
    offsetOf: above,

    at(pixel) {
      // Binary search over the same tree: no cache to fill first.
      let low = 0
      let high = rows.length - 1
      while (low < high) {
        const mid = (low + high + 1) >> 1
        if (above(mid) <= pixel) low = mid
        else high = mid - 1
      }
      return { index: low, into: pixel - above(low) }
    },

    measure(index, height) {
      rows[index]?.set(height)
    },

    prepend(fresh) {
      // Rows keep their cells; the new ones take the low indices, so the tree
      // above them is rebuilt where it must be and kept where it need not.
      rows = [...fresh.map((h, i) => stored(h, { name: `p${i}` })), ...rows]
    },

    size: () => rows.length,
    walked: () => tree.worked(),
    resetWalked: () => tree.resetWorked(),
  }
}
