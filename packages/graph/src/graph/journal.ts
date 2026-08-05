// The journal is a probe with a memory: it keeps the last waves, answers
// "why did this change" with the wave that touched it, and replays recorded
// writes into a fresh graph — inputs are the whole entropy of a pure graph,
// so the write log is the full history and the replay is a time machine.
//
// The honest limit, stated up front: replay restores what formulas derive.
// State that lives beside the graph — a table's rows, a source's held answer —
// shows its version numbers in the waves but is not rebuilt by them; replaying
// such an app needs its own journals underneath. Watching is unaffected:
// waves read fine either way.

import { attachProbe, batch } from './graph.ts'
import type { Engine, Input } from './graph.ts'
import type { WaveSummary } from './waves.ts'

export interface Journal {
  /** Start remembering. Detach with stop(); the memory stays readable. */
  start(): void
  stop(): void
  waves(): readonly WaveSummary[]
  /** The last wave that wrote, recomputed or gated this node. */
  why(node: string): WaveSummary | undefined
  /** Re-apply the recorded writes, wave by wave, one batch per wave. */
  replay(resolve: (node: string) => Input<unknown> | undefined): void
  clear(): void
}

export function journal(
  keep = 256,
  onWave?: (wave: WaveSummary) => void,
  engine?: Engine,
): Journal {
  const memory: WaveSummary[] = []

  return {
    start() {
      attachProbe(
        {
          wave(summary: WaveSummary) {
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
    waves: () => memory,
    why(node) {
      for (let i = memory.length - 1; i >= 0; i--) {
        const wave = memory[i]
        if (wave === undefined) continue
        if (
          wave.writes.some(w => w.node === node) ||
          wave.computed.some(c => c.node === node) ||
          wave.gated.includes(node)
        )
          return wave
      }
      return undefined
    },
    replay(resolve) {
      const group = engine === undefined ? batch : engine.batch
      for (const wave of memory) {
        group(() => {
          for (const write of wave.writes) resolve(write.node)?.set(write.value)
        })
      }
    },
    clear: () => {
      memory.length = 0
    },
  }
}
