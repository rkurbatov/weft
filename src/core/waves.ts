// Waves. The graph's natural unit of work is not an action but a wave: one
// batch of writes into inputs, the recomputes it causes, the places it dies on
// equality, the watchers it wakes. The probe below taps exactly that — every
// call from the hot path is behind one null check, so a detached probe costs
// nothing but that check.
//
// A wave opens on the first write and closes when the outermost work ends.
// Recomputes pulled by a plain read, with no write behind them, belong to no
// wave: a wave is a consequence, a read is a question.

export interface WaveWrite {
  node: string
  value: unknown
}

export interface WaveCompute {
  node: string
  ms: number
  changed: boolean
}

export interface WaveSummary {
  id: number
  at: number
  ms: number
  writes: WaveWrite[]
  computed: WaveCompute[]
  /** Where the wave died on equality: recomputed, same value, nobody below woke. */
  gated: string[]
  woke: number
}

export interface Probe {
  write?(node: string, value: unknown): void
  compute?(node: string, ms: number, changed: boolean): void
  /** The red dot: this node recomputed to an equal value and stopped the wave. */
  gate?(node: string): void
  wake?(): void
  wave?(summary: WaveSummary): void
}

let probe: Probe | null = null
let open: WaveSummary | null = null
let waveId = 0
let openedAt = 0

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/** Attach one probe (or null to detach). Composition is the caller's business. */
export function attachProbe(next: Probe | null): void {
  probe = next
  open = null
}

export const waves = {
  /** Whether anything listens — hot paths use it to skip the timing calls. */
  get on(): boolean {
    return probe !== null
  },

  now: clock,

  write(node: string, value: unknown): void {
    if (probe === null) return
    if (open === null) {
      openedAt = clock()
      open = { id: ++waveId, at: Date.now(), ms: 0, writes: [], computed: [], gated: [], woke: 0 }
    }
    open.writes.push({ node, value })
    probe.write?.(node, value)
  },

  compute(node: string, ms: number, changed: boolean, hadValue: boolean): void {
    if (probe === null) return
    probe.compute?.(node, ms, changed)
    const gated = hadValue && !changed
    if (gated) probe.gate?.(node)
    if (open === null) return
    open.computed.push({ node, ms, changed })
    if (gated) open.gated.push(node)
  },

  wake(): void {
    if (probe === null) return
    probe.wake?.()
    if (open !== null) open.woke++
  },

  /** The outermost work ended: if a wave is open, it is done. */
  close(): void {
    if (probe === null || open === null) return
    const summary = open
    open = null
    summary.ms = clock() - openedAt
    probe.wave?.(summary)
  },
}
