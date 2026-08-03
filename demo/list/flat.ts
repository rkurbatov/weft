// The third way, now the library's: `offsets` from the front door — a flat
// Fenwick tree fed by deltas, with a lazy rebuild when rows enter or leave.
// This adapter only bends it to the shared List interface of the bench.

import { offsets } from '#weft'
import type { List } from './classic.ts'

export function flatList(heights: number[]): List {
  const line = offsets(heights)
  return {
    offsetOf: index => line.offsetOf(index),
    at: pixel => line.at(pixel),
    measure: (index, height) => line.measure(index, height),
    prepend: fresh => line.insert(0, fresh),
    size: () => line.size(),
    walked: () => line.worked(),
    resetWalked: () => line.resetWorked(),
  }
}
