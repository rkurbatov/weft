// A table that lives in a worker, followed whole.
//
// The other table page shows a window: only what fits on screen crosses. This
// one is about the protocol underneath — the whole table is followed, so what
// crosses is one snapshot and then batches of what changed. Five thousand rows
// is enough to see that; the point here is the protocol, not the size.
//
// The page can also drop batches on purpose, because the interesting part is
// not the happy path: a follower that missed a batch must notice and ask to
// catch up, rather than apply changes onto a state they were not made for.

import { cell } from '#loom'
import type { Port, Watchable } from '#loom'
import { table } from '#weft'
import type { Key, SourceTable } from '#weft'

export interface Job {
  readonly id: number
  readonly title: string
  readonly state: 'waiting' | 'running' | 'done'
  readonly at: number
}

const STATES = ['waiting', 'running', 'done'] as const

export interface Desk {
  readonly jobs: SourceTable<Job>
  readonly size: Watchable<number>
  /** How many rows have been poured in since the page opened. */
  readonly poured: Port<number>
  /** How many rows have been edited in place. */
  readonly edited: Port<number>
  /** Pour another batch of rows in. */
  pour(count: number): void
  /** Edit a handful of rows that are already there. */
  touch(count: number): void
  stop(): void
}

export function desk(seed = 2_000): Desk {
  const jobs = table<Job>({ key: row => row.id as Key, name: 'jobs' })
  const poured = cell(0, { name: 'poured' })
  const edited = cell(0, { name: 'edited' })
  let next = 0

  const pour = (count: number): void => {
    const rows: Job[] = []
    for (let i = 0; i < count; i++) {
      const id = next++
      rows.push({
        id,
        title: `job ${String(id).padStart(5, '0')}`,
        state: 'waiting',
        at: Date.now(),
      })
    }
    // One collection, one argument: never spread into call arguments.
    jobs.put(rows)
    poured.set(poured.peek() + rows.length)
  }

  const touch = (count: number): void => {
    if (next === 0) return
    const rows: Job[] = []
    for (let i = 0; i < count; i++) {
      const id = Math.floor(Math.random() * next)
      const had = jobs.row(id).peek()
      if (had === undefined) continue
      rows.push({ ...had, state: STATES[(STATES.indexOf(had.state) + 1) % 3] ?? 'waiting' })
    }
    if (rows.length === 0) return
    jobs.put(rows)
    edited.set(edited.peek() + rows.length)
  }

  pour(seed)

  // A worker that keeps working: rows arrive and rows change, the way a real
  // corpus does while it is being processed.
  const beat = setInterval(() => {
    pour(20)
    touch(30)
  }, 500)

  return {
    jobs,
    size: jobs.size,
    poured,
    edited,
    pour,
    touch,
    stop: () => {
      clearInterval(beat)
      jobs.dispose()
    },
  }
}
