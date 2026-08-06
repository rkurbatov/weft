// The engine: a state module that lives wherever it is put.
//
// Ordinary weft — a port for what is typed, a port for how big the log is,
// and one derived answer that does the searching. Nothing here knows about
// workers, wires or panels, and that is the point of the page: the same file
// runs in a worker or on the main thread without a character changing.

import { cell } from '#loom'
import type { Port, Watchable } from '#loom'
import { logLines, search } from '../engine-common/corpus.ts'
import type { Line } from '../engine-common/corpus.ts'

export interface Found {
  /** The first fifty matching lines — what a screen can actually show. */
  readonly lines: readonly Line[]
  /** How many matched altogether. */
  readonly total: number
  /** How long this search took, in milliseconds. */
  readonly ms: number
  /** How many lines were searched through. */
  readonly of: number
}

export interface Engine {
  /** What the panel typed. */
  readonly needle: Port<string>
  /** How many lines of made-up log to search. */
  readonly size: Port<number>
  /** The answer. Recomputed only while somebody is looking at it. */
  readonly found: Watchable<Found>
  /** How many searches have actually run since this engine started. */
  readonly searches: Watchable<number>
}

export function engine(): Engine {
  const needle = cell('', { name: 'needle' })
  const size = cell(200_000, { name: 'size' })

  // The log is derived too: change the size and another one is built, with
  // nobody having to remember to rebuild anything.
  const log = cell<Line[]>(() => logLines(size.get()), { name: 'log' })

  // Instrumentation, written from inside the formula on purpose: it feeds
  // nothing in the graph and nothing in the graph reads it.
  const ran = cell(0, { name: 'searches' })

  const found = cell<Found>(
    () => {
      const lines = log.get()
      const answer = search(lines, needle.get())
      ran.set(ran.peek() + 1)
      return { lines: answer.found, total: answer.total, ms: answer.ms, of: lines.length }
    },
    { name: 'found' },
  )

  return { needle, size, found, searches: ran }
}
