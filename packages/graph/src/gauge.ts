// One instrument, one attachment point.
//
// The engine holds a single probe, so counters and a journal could never be on
// at the same time: whichever attached last silently took the seat, and a
// screen showing both was showing one of them frozen. Four doors — counters,
// journal, the probe itself, the trace — for one question, "what is the graph
// doing", and three of them fighting over one socket.
//
// A gauge is that one door. It attaches once and hands out both readings, so
// nothing has to be chosen and nothing goes quietly dead. The probe stays
// available underneath for whoever builds another instrument.

import { attachProbe, batch, port } from './graph.ts'
import type { Engine, Port } from './graph.ts'
import { coreForBuild } from './engine.ts'
import { quietly } from './ticks.ts'
import type { TickSummary } from './ticks.ts'

export interface Counted {
  /** Settlings that have finished. */
  readonly ticks: Port<number>
  /** Formulas recomputed, over all ticks. */
  readonly computed: Port<number>
  /** Watcher bodies run. */
  readonly woken: Port<number>
  /** Recomputes that ended on the same value and stopped there. */
  readonly gated: Port<number>
  /** Formulas or watcher bodies that threw. */
  readonly failed: Port<number>
  /** Watchers alive right now. */
  readonly watching: Port<number>
  /** The deepest the queue got in the last tick. */
  readonly queued: Port<number>
}

export interface Recorded {
  /** The ticks still remembered, oldest first. */
  ticks(): readonly TickSummary[]
  /** The last tick that wrote, recomputed or gated this node. */
  why(node: string): TickSummary | undefined
  /** Re-apply the recorded writes, tick by tick, one batch per tick. */
  replay(resolve: (node: string) => Port<unknown> | undefined): void
  clear(): void
}

export interface Gauge {
  /** Running totals, as cells: read them in a formula and a screen follows. */
  readonly counts: Counted
  /** What happened, tick by tick, as far back as `keep`. */
  readonly log: Recorded
  /** Measure again after a stop. A gauge starts measuring when it is made. */
  start(): void
  /** Let the probe go. The readings taken so far stay readable. */
  stop(): void
}

export interface GaugeOptions {
  /** How many ticks the log remembers. */
  keep?: number
  /** Called on every tick, after both readings are updated. */
  onTick?: (tick: TickSummary) => void
  engine?: Engine
}

export function gauge(options: GaugeOptions = {}): Gauge {
  const { keep = 256, onTick, engine } = options
  const core = engine === undefined ? coreForBuild() : engine.core

  const counts: Counted = {
    ticks: port(0, { name: 'gauge.ticks' }),
    computed: port(0, { name: 'gauge.computed' }),
    woken: port(0, { name: 'gauge.woken' }),
    gated: port(0, { name: 'gauge.gated' }),
    failed: port(0, { name: 'gauge.failed' }),
    watching: port(0, { name: 'gauge.watching' }),
    queued: port(0, { name: 'gauge.queued' }),
  }

  const memory: TickSummary[] = []
  let deepest = 0

  const probe = {
    compute: () => {
      deepest = Math.max(deepest, core.queued)
    },
    tick: (summary: TickSummary) => {
      memory.push(summary)
      while (memory.length > keep) memory.shift()
      // Quietly: counting is not a write anybody asked for, and a screen
      // reading a counter must not make the next tick look busier than it was.
      quietly(() => {
        counts.ticks.set(counts.ticks.peek() + 1)
        counts.computed.set(counts.computed.peek() + summary.computed.length)
        counts.woken.set(counts.woken.peek() + summary.woke)
        counts.gated.set(counts.gated.peek() + summary.gated.length)
        counts.failed.set(counts.failed.peek() + summary.failed.length)
        counts.watching.set(core.watching)
        counts.queued.set(deepest)
      })
      deepest = 0
      onTick?.(summary)
    },
  }

  core.tap.attach(probe)

  const log: Recorded = {
    ticks: () => memory,
    why(node) {
      for (let i = memory.length - 1; i >= 0; i--) {
        const tick = memory[i]
        if (tick === undefined) continue
        if (
          tick.writes.some(w => w.node === node) ||
          tick.computed.some(c => c.node === node) ||
          tick.gated.includes(node)
        )
          return tick
      }
      return undefined
    },
    replay(resolve) {
      const group = engine === undefined ? batch : engine.batch
      for (const tick of memory) {
        group(() => {
          for (const write of tick.writes) resolve(write.node)?.set(write.value)
        })
      }
    },
    clear: () => {
      memory.length = 0
    },
  }

  return {
    counts,
    log,
    start: () => core.tap.attach(probe),
    stop: () => attachProbe(null, engine),
  }
}
