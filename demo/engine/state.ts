// The engine: a state module that lives wherever it is put.
//
// Ordinary weft — ports for what the panel types, and a source that does the
// searching. Nothing here knows about workers, wires or panels: the same file
// runs in a worker or on the main thread without a character changing.
//
// The search is a long run, so it is a source with a body that reports as it
// goes: every chunk publishes what it has, and the panel shows a real answer
// over part of the log rather than a spinner over all of it.

import { cell, giveWay, truthBy } from '#loom'
import type { Port, Tally, Watchable } from '#loom'
import { logLines, searching } from './corpus.ts'
import type { Line, Log, Progress } from './corpus.ts'

export interface Found {
  /** Matches per bucket — the bulk number that crosses the wire. */
  readonly hist: Float64Array
  /** The first fifty matching lines — what a screen can actually show. */
  readonly lines: readonly Line[]
  /** How many matched among the lines looked at so far. */
  readonly total: number
  /** How many lines have been looked at, out of how many there are. */
  readonly seen: number
  readonly of: number
  /** Whether this is the whole answer or a real answer over part of the log. */
  readonly done: boolean
  readonly ms: number
}

export interface Engine {
  readonly needle: Port<string>
  readonly size: Port<number>
  /** The answer, growing while the run goes on. */
  readonly found: Watchable<Found>
  /** How much memory the corpus itself takes, in bytes. */
  readonly corpusBytes: Watchable<number>
  /**
   * What the searching has done: asked, answered, called off, published.
   *
   * Kept by the library, not counted here. Counting it in this file is what
   * went wrong before: a run called off between two chunks never got a turn to
   * notice, and a finished run whose question was dropped was counted as
   * called off.
   */
  readonly tally: Tally
}

const EMPTY: Found = {
  hist: new Float64Array(24),
  lines: [],
  total: 0,
  seen: 0,
  of: 0,
  done: true,
  ms: 0,
}

/** A step of the run, said in the words the panel reads. */
const shown = (step: Progress, of: number): Found => ({
  hist: step.hist,
  lines: step.found,
  total: step.total,
  seen: step.seen,
  of,
  done: step.done,
  ms: step.ms,
})

export function engine(): Engine {
  const needle = cell('', { name: 'needle' })
  // Four million lines: a search takes about a second, which is what makes a
  // called-off run visible at ordinary typing speed. Two million searched in a
  // quarter of a second, and nobody types that fast.
  const size = cell(4_000_000, { name: 'size' })
  const log = cell<Log>(() => logLines(size.get()), { name: 'log' })
  const corpusBytes = cell(() => log.get().size, { name: 'corpusBytes' })

  // Keyed by the pattern, not by nothing: a source is asked once per key, so
  // the key has to be the question. Typing changes the key, which is what
  // calls the old run off — the same mechanism the order asks for, rather than
  // a second one written by hand.
  const runFor = truthBy<string, Found>(
    async (asked, { signal, soFar }) => {
      const held = log.peek()
      const run = searching(held, asked)

      let step = run.next()
      while (step.done === false) {
        // Between chunks: has anybody stopped caring? A run whose demand has
        // left, or whose pattern has changed, is called off here — and its
        // `soFar` would land nowhere anyway.
        // Stop as soon as the answer stops being wanted; the counting is
        // already done above.
        if (signal.aborted) return shown(step.value, held.length)
        soFar(shown(step.value, held.length))
        // Let the page paint and the abort arrive. Awaiting in a loop is the
        // point here: this loop is the long run, and the yield between chunks
        // is what makes it interruptible at all.
        // oxlint-disable-next-line no-await-in-loop
        await giveWay()
        step = run.next()
      }
      return shown(step.value, held.length)
    },
    { name: 'found', empty: EMPTY },
  )

  // What the panel watches: the run for whatever is typed right now, and the
  // tally of the run behind it.
  const found = cell(() => runFor(needle.get()).get(), { name: 'found' })
  // The tally is the family's, so it counts every run of every pattern typed —
  // including the ones called off when the next letter arrived.
  return { needle, size, found, corpusBytes, tally: runFor.tally }
}
