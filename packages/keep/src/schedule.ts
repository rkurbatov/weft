// When to try again.
//
// Doubling with a cap, one timer at a time, and a switch for being held. It
// knows nothing about books, entries or handlers — which is what makes it
// testable with a fake clock and nothing else.

import { backoff } from '#data'
import { wallClock } from '#graph/time.ts'
import type { Timers } from '#graph/time.ts'

export interface ScheduleOptions {
  /** Wait before a retry; doubles per attempt, capped by cap. */
  retry?: number
  cap?: number
  timers?: Timers
  /** Start held: nothing is scheduled until `resume()`. */
  paused?: boolean
}

export interface Schedule {
  /** The wait after this many refusals. */
  backoff(attempt: number): number
  /** Do this after a delay, replacing whatever was waiting. */
  after(delay: number, work: () => void): void
  /** Whether something is waiting on the clock right now. */
  waiting(): boolean
  cancel(): void
  held(): boolean
  hold(): void
  release(): void
}

export function schedule(options: ScheduleOptions = {}): Schedule {
  const retry = options.retry ?? 1000
  const cap = options.cap ?? retry * 32
  const timers = options.timers ?? wallClock
  let held = options.paused ?? false
  let timer: unknown = null

  function cancel(): void {
    if (timer === null) return
    timers.clear(timer)
    timer = null
  }

  return {
    backoff: attempt => backoff(attempt, retry, cap),
    after(delay, work) {
      cancel()
      timer = timers.set(() => {
        timer = null
        work()
      }, delay)
    },
    waiting: () => timer !== null,
    cancel,
    held: () => held,
    hold() {
      held = true
      cancel()
    },
    release() {
      held = false
    },
  }
}
