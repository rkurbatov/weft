// The journal is a probe with a memory: it keeps the last ticks, answers
// "why did this change" with the tick that touched it, and replays recorded
// writes into a fresh graph — inputs are the whole entropy of a pure graph,
// so the write log is the full history and the replay is a time machine.
//
// The honest limit, stated up front: replay restores what formulas derive.
// State that lives beside the graph — a table's rows, a source's held answer —
// shows its version numbers in the ticks but is not rebuilt by them; replaying
// such an app needs its own journals underneath. Watching is unaffected:
// ticks read fine either way.

import { attachProbe, batch } from './graph.ts'
import type { Engine, Port } from './graph.ts'
import type { TickSummary } from './ticks.ts'

export interface Journal {
  /** Start remembering. Detach with stop(); the memory stays readable. */
  start(): void
  stop(): void
  ticks(): readonly TickSummary[]
  /** The last tick that wrote, recomputed or gated this node. */
  why(node: string): TickSummary | undefined
  /** Re-apply the recorded writes, tick by tick, one batch per tick. */
  replay(resolve: (node: string) => Port<unknown> | undefined): void
  clear(): void
}

export function journal(
  keep = 256,
  onWave?: (tick: TickSummary) => void,
  engine?: Engine,
): Journal {
  const memory: TickSummary[] = []

  return {
    start() {
      attachProbe(
        {
          tick(summary: TickSummary) {
            memory.push(summary)
            while (memory.length > keep) memory.shift()
            onWave?.(summary)
          },
        },
        engine,
      )
    },
    stop() {
      attachProbe(null, engine)
    },
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
}
