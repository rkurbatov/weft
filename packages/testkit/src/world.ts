// A world the test drives by hand: the clock, the timer queue, and the two
// waits that come up in every asynchronous test.
//
// This used to be copied into every file that needed it — eight copies of the
// clock, ten of `settle`, twelve of `wait`. One copy means one place to fix
// when the shape of time changes, and one place to make it safe.

import type { Timers } from '#graph'
import { cleanupWith } from './lifetime.ts'

/** Let promise callbacks run. The shortest wait there is. */
/**
 * Let queued work run. A timeout on purpose rather than the library's
 * `giveWay`: settling in a test has to wait for timers as well, and the fast
 * yield runs before them.
 */
export function settle(turns = 1): Promise<void> {
  return turns <= 1
    ? new Promise(resolve => setTimeout(resolve, 0))
    : (async () => {
        // oxlint-disable-next-line no-await-in-loop
        for (let i = 0; i < turns; i++) await new Promise(resolve => setTimeout(resolve, 0))
      })()
}

/** Real waiting, for the few tests that must meet the wall clock. */
export function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export interface World {
  readonly timers: Timers
  now(): number
  /** Jobs still on the clock. A test that ends with these has left something running. */
  pending(): number
  /** Move time forward, firing whatever comes due, settling after each. */
  advance(ms: number): Promise<void>
  /** Fire what is due without moving time — for jobs set for "now". */
  drain(): Promise<void>
  /** Move the clock without firing anything: for testing what has gone stale. */
  jump(ms: number): void
}

/**
 * A stopped clock with a queue the test moves itself. Registered for cleanup,
 * so an unfinished job cannot outlive its test and fire into the next one.
 */
export function world(start = 1000): World {
  let time = start
  let next = 1
  const jobs = new Map<number, { at: number; fn: () => void }>()
  const timers: Timers = {
    set: (fn, ms) => {
      const id = next++
      jobs.set(id, { at: time + ms, fn })
      return id
    },
    clear: handle => {
      jobs.delete(handle as number)
    },
  }
  const due = (until: number): [number, { at: number; fn: () => void }] | undefined =>
    [...jobs.entries()]
      .filter(([, job]) => job.at <= until)
      .toSorted((a, b) => a[1].at - b[1].at)[0]

  cleanupWith(() => jobs.clear())

  return {
    timers,
    now: () => time,
    pending: () => jobs.size,
    jump(ms) {
      time += ms
    },
    async advance(ms) {
      const until = time + ms
      for (;;) {
        const job = due(until)
        if (job === undefined) break
        jobs.delete(job[0])
        time = job[1].at
        job[1].fn()
        await settle()
      }
      time = until
      await settle()
    },
    async drain() {
      for (;;) {
        const job = due(time)
        if (job === undefined) break
        jobs.delete(job[0])
        job[1].fn()
        await settle()
      }
    },
  }
}
