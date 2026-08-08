// What the graph is doing, as ordinary cells.
//
// Counters a screen can watch like anything else: how many ticks have settled,
// how many formulas recomputed, how many watchers woke, how many recomputes
// ended in the same value, how many failed, how many watchers are alive, and
// how deep the queue got.
//
// Built on the probe the journal already uses, so the hot path is untouched
// when nobody is counting — and off by default, because a counter nobody reads
// is work nobody asked for.
//
// The writes are quiet. A counter is a cell, and counting a tick inside the
// settling of that tick would count itself: instrumentation that feeds itself
// is the one bug this whole file exists to make unnecessary in applications.

import { port } from './graph.ts'
import { quietly } from './ticks.ts'
import type { Engine } from './graph.ts'
import type { Watchable } from './nodes.ts'
import { coreForBuild } from './engine.ts'

export interface Counters {
  /** Settlings that have finished. */
  readonly ticks: Watchable<number>
  /** Formulas recomputed, over all ticks. */
  readonly computed: Watchable<number>
  /** Watcher bodies run. */
  readonly woken: Watchable<number>
  /** Recomputes that ended on the same value and stopped there. */
  readonly gated: Watchable<number>
  /** Formulas or watcher bodies that threw. */
  readonly failed: Watchable<number>
  /** Watchers alive right now. */
  readonly watching: Watchable<number>
  /** The deepest the queue got in the last tick. */
  readonly queued: Watchable<number>
  /** Stop counting and let the probe go. */
  stop(): void
}

/**
 * Start counting on an engine — the one being built into, unless another is
 * named.
 *
 * Only one probe may be attached at a time, so this and the journal are not
 * both on at once; whichever was attached last wins.
 */
export function counters(engine?: Engine): Counters {
  const core = engine === undefined ? coreForBuild() : engine.core

  const ticks = port(0, { name: 'counters.ticks' })
  const computed = port(0, { name: 'counters.computed' })
  const woken = port(0, { name: 'counters.woken' })
  const gated = port(0, { name: 'counters.gated' })
  const failed = port(0, { name: 'counters.failed' })
  const watching = port(0, { name: 'counters.watching' })
  const queued = port(0, { name: 'counters.queued' })

  let deepest = 0

  core.tap.attach({
    compute: () => {
      deepest = Math.max(deepest, core.queued)
    },
    tick: summary => {
      quietly(() => {
        ticks.set(ticks.peek() + 1)
        computed.set(computed.peek() + summary.computed.length)
        woken.set(woken.peek() + summary.woke)
        gated.set(gated.peek() + summary.gated.length)
        failed.set(failed.peek() + summary.failed.length)
        watching.set(core.watching)
        queued.set(deepest)
      })
      deepest = 0
    },
  })

  return {
    ticks,
    computed,
    woken,
    gated,
    failed,
    watching,
    queued,
    stop: () => core.tap.detach(),
  }
}
