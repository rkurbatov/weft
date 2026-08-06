// The engine's own side: a state module that lives where the graph lives.
//
// This is the thing the order is about (З-1). Everything here is ordinary
// weft — ports, derived cells, a family — and none of it knows whether it runs
// in a worker, in a leading tab, or in the page itself. What decides that is
// one line in main.tsx.
//
// The work is deliberately slow and deliberately demand-driven: it recomputes
// only when somebody is looking at its answer. The tick counter is how the
// page proves it — a number that climbs while a panel is open and stops dead
// when it closes.

import { cell, family } from '#loom'
import type { Port, Watchable } from '#loom'
import { corpus, countMatching, histogram } from '../engine-common/corpus.ts'
import type { Entry } from '../engine-common/corpus.ts'

export interface Engine {
  /** What the panels type in. */
  readonly needle: Port<string>
  /** How much made-up corpus to work over. */
  readonly size: Port<number>
  /** How many entries match — the expensive answer. */
  readonly matches: Watchable<number>
  /** The same work as a shape, so a panel can draw it. */
  readonly shape: Watchable<readonly number[]>
  /** One answer per bucket, asked for separately: a family of the same work. */
  readonly bucket: (at: number) => Watchable<number>
  /** How many times the work has actually run since this engine was built. */
  readonly ticks: Watchable<number>
}

export function engine(): Engine {
  const needle = cell('')
  const size = cell(20_000)

  // The corpus itself is derived: changing the size builds another one, and
  // nobody has to remember to rebuild anything.
  const body = cell<Entry[]>(() => corpus(size.get()), { name: 'corpus' })

  // The tick counter is written from inside the formulas below. Writing from a
  // formula is normally a sin — here the counter is instrumentation, it feeds
  // nothing, and nothing reads it inside the graph.
  const ticked = cell(0, { name: 'ticks' })
  const tick = (): void => {
    ticked.set(ticked.peek() + 1)
  }

  const matches = cell(
    () => {
      const answer = countMatching(body.get(), needle.get())
      tick()
      return answer
    },
    { name: 'matches' },
  )

  const shape = cell<readonly number[]>(
    () => {
      const answer = histogram(body.get(), needle.get())
      tick()
      return answer
    },
    { name: 'shape' },
  )

  // A family: one answer per bucket, each asked for on its own. A panel that
  // shows three bars keeps three of them alive and no more.
  const bucket = family((at: number) => shape.get()[at] ?? 0, { name: 'bucket', max: 64 })

  return { needle, size, matches, shape, bucket, ticks: ticked }
}
