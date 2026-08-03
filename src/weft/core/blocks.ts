// Block folds: an answer over a long range without reading the whole range.
//
// Cut a line into blocks of `span`, keep each block's partial answer in a cell
// of its own, and build blocks of blocks above them. One edit then touches one
// partial per level and the answer — a handful of joins instead of the whole
// line. Each partial is an ordinary cell, so what depends on what, and what has
// to be redone, is the graph's business.
//
// Correctness rests on the caller: `join` must be associative and exact in its
// own type, since a blockwise answer is only the same answer as a left-to-right
// one when it is. `zero` is the identity — the answer for an empty range.

import { family } from './family.ts'

export interface BlockOptions<T> {
  /** One element's contribution to the answer. */
  read: (line: string, at: number) => T
  /** The answer for an empty range. */
  zero: T
  /** Associative and exact: (a·b)·c = a·(b·c). */
  join: (a: T, b: T) => T
  /** Elements per block; a level up covers `span` times as much. */
  span?: number
  /** Ceiling for the partials kept unwatched. */
  max?: number
  name?: string
}

export interface Blocks<T> {
  /** The answer for [from, to] along one line, inclusive. */
  range: (line: string, from: number, to: number) => T
  /** Partials worked out since the last reset — for benchmarks, not for logic. */
  worked: () => number
  resetWorked: () => void
}

export function blocks<T>(options: BlockOptions<T>): Blocks<T> {
  const { read, zero, join, span = 32, max = 500_000, name = 'block' } = options
  let worked = 0

  // Key: line|level|index. Level 0 covers elements, each level above covers
  // `span` blocks below it.
  const partial = family(
    (key: string): T => {
      worked++
      const cut = key.lastIndexOf('|')
      const under = key.lastIndexOf('|', cut - 1)
      const line = key.slice(0, under)
      const level = Number(key.slice(under + 1, cut))
      const index = Number(key.slice(cut + 1))

      let answer = zero
      const first = index * span
      if (level === 0) {
        for (let at = first; at < first + span; at++) answer = join(answer, read(line, at))
        return answer
      }
      for (let child = first; child < first + span; child++) {
        answer = join(answer, partial(`${line}|${level - 1}|${child}`).get())
      }
      return answer
    },
    { name, max },
  )

  const covers = (level: number): number => span ** (level + 1)

  return {
    range(line, from, to) {
      let answer = zero
      let at = from
      while (at <= to) {
        // The largest aligned block that still fits inside the range.
        let level = -1
        while (at % covers(level + 1) === 0 && at + covers(level + 1) - 1 <= to) level++
        if (level >= 0) {
          answer = join(answer, partial(`${line}|${level}|${at / covers(level)}`).get())
          at += covers(level)
        } else {
          answer = join(answer, read(line, at))
          at++
        }
      }
      return answer
    },

    worked: () => worked,
    resetWorked: () => {
      worked = 0
    },
  }
}
