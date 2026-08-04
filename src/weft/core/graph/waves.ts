// Waves. The graph's natural unit of work is not an action but a wave: one
// batch of writes into inputs, the recomputes it causes, the places it dies on
// equality, the watchers it wakes. The tap below records exactly that — every
// call from the hot path is behind one null check, so an unwatched tap costs
// nothing but that check.
//
// A wave opens on the first write and closes when the outermost work ends.
// Recomputes pulled by a plain read, with no write behind them, belong to no
// wave: a wave is a consequence, a read is a question.
//
// One tap per engine: debugging one session is not mixed with another's.

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

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

let hushed = false

/** Writes made in here are the probe's own plumbing: no probe sees itself. */
export function quietly(work: () => void): void {
  const was = hushed
  hushed = true
  try {
    work()
  } finally {
    hushed = was
  }
}

export class WaveTap {
  /** Plain field, not a getter: the hot path reads it on every write. */
  watching = false
  private probe: Probe | null = null
  private open: WaveSummary | null = null
  private waveId = 0
  private openedAt = 0

  /** Whether anything listens — hot paths use it to skip the timing calls. */
  get on(): boolean {
    return this.watching
  }

  now = clock

  attach(next: Probe | null): void {
    this.probe = next
    this.watching = next !== null
    this.open = null
  }

  detach(): void {
    this.attach(null)
  }

  write(node: string, value: unknown): void {
    if (this.probe === null || hushed) return
    if (this.open === null) {
      this.openedAt = clock()
      this.open = {
        id: ++this.waveId,
        at: Date.now(),
        ms: 0,
        writes: [],
        computed: [],
        gated: [],
        woke: 0,
      }
    }
    this.open.writes.push({ node, value })
    this.probe.write?.(node, value)
  }

  compute(node: string, ms: number, changed: boolean, hadValue: boolean): void {
    if (this.probe === null || hushed) return
    this.probe.compute?.(node, ms, changed)
    const gated = hadValue && !changed
    if (gated) this.probe.gate?.(node)
    if (this.open === null) return
    this.open.computed.push({ node, ms, changed })
    if (gated) this.open.gated.push(node)
  }

  wake(): void {
    if (this.probe === null || hushed) return
    this.probe.wake?.()
    if (this.open !== null) this.open.woke++
  }

  /** The outermost work ended: if a wave is open, it is done. */
  close(): void {
    if (this.probe === null || this.open === null) return
    const summary = this.open
    this.open = null
    summary.ms = clock() - this.openedAt
    this.probe.wave?.(summary)
  }
}
