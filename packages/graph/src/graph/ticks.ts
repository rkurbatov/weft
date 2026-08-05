// Waves. The graph's natural unit of work is not an action but a tick: one
// batch of writes into inputs, the recomputes it causes, the places it dies on
// equality, the watchers it wakes. The tap below records exactly that — every
// call from the hot path is behind one null check, so an unwatched tap costs
// nothing but that check.
//
// A tick opens on the first write and closes when the outermost work ends.
// Recomputes pulled by a plain read, with no write behind them, belong to no
// tick: a tick is a consequence, a read is a question.
//
// One tap per engine: debugging one session is not mixed with another's.

export interface TickWrite {
  node: string
  value: unknown
}

export interface TickCompute {
  node: string
  ms: number
  changed: boolean
}

export interface TickSummary {
  id: number
  at: number
  ms: number
  writes: TickWrite[]
  computed: TickCompute[]
  /** Where the tick died on equality: recomputed, same value, nobody below woke. */
  gated: string[]
  /** Where it broke: a formula or a watcher body threw during this tick. */
  failed: string[]
  woke: number
}

export interface Probe {
  write?(node: string, value: unknown): void
  compute?(node: string, ms: number, changed: boolean): void
  /** The red dot: this node recomputed to an equal value and stopped the tick. */
  gate?(node: string): void
  /** A formula or a watcher body threw. The node is named; the error is as thrown. */
  fail?(node: string, error: unknown): void
  wake?(): void
  tick?(summary: TickSummary): void
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

export class TickTap {
  /** Plain field, not a getter: the hot path reads it on every write. */
  watching = false
  private probe: Probe | null = null
  private open: TickSummary | null = null
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
        failed: [],
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

  fail(node: string, error: unknown): void {
    if (this.probe === null || hushed) return
    this.probe.fail?.(node, error)
    if (this.open !== null) this.open.failed.push(node)
  }

  wake(): void {
    if (this.probe === null || hushed) return
    this.probe.wake?.()
    if (this.open !== null) this.open.woke++
  }

  /** The outermost work ended: if a tick is open, it is done. */
  close(): void {
    if (this.probe === null || this.open === null) return
    const summary = this.open
    this.open = null
    summary.ms = clock() - this.openedAt
    this.probe.tick?.(summary)
  }
}
