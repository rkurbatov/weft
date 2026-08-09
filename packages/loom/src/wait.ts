// Waiting on state, and acting on it for as long as it takes.
//
// Two words for the niche people reach for RxJS to fill. Neither is a stream:
// both read state, because state is what this library has, and a stream would
// mean a second way to say the same thing.
//
// `when` is a promise that settles once the state says so — for a step in a
// procedure that has to wait for something. `whenever` is a standing handler
// that runs whenever what it reads changes — for the work that follows the
// state rather than the calendar.

import { subscribe, untracked } from '#weft'
import { wallClock } from '#core'
import { owned } from '#graph'
import type { Watchable } from '#weft'
import type { Timers } from '#core'

export interface WhenOptions {
  /**
   * How long to wait before giving up. Waiting has a deadline for the same
   * reason a request does: a condition that never comes true is
   * indistinguishable from one that is merely slow.
   */
  timeout?: number
  /**
   * Watch without asking for the work. By default waiting asks: a source
   * nobody else is looking at would never load, and a replica with no watcher
   * forgets its value — so the wait would be for something that cannot happen.
   * `cold: true` is for waiting on what somebody else is already keeping alive.
   */
  cold?: boolean
  /** Give up when this is aborted — the standard way, so it composes. */
  signal?: AbortSignal
  timers?: Timers
}

export class Timeout extends Error {
  constructor(ms: number) {
    super(`weft: waited ${ms}ms and the condition did not come true`)
    this.name = 'Timeout'
  }
}

/**
 * A promise that settles when the state satisfies the test.
 *
 * If the state already satisfies it, the promise is already settled: waiting
 * for something that has happened is not waiting.
 *
 * ```ts
 * await when(() => board.state.get(), s => s.kind === 'held', { timeout: 5000 })
 * ```
 */
export function when<T>(
  read: () => T,
  test: (value: T) => boolean = Boolean as (value: T) => boolean,
  options: WhenOptions = {},
): Promise<T> {
  const timers = options.timers ?? wallClock
  return new Promise<T>((resolve, reject) => {
    let done = false
    let stop: (() => void) | undefined
    let timer: unknown

    const finish = (settle: () => void): void => {
      if (done) return
      done = true
      if (timer !== undefined) timers.clear(timer)
      // The stop may not exist yet: the condition can be true on the first read.
      queueMicrotask(() => stop?.())
      settle()
    }

    if (options.signal?.aborted === true) {
      reject(options.signal.reason as Error)
      return
    }
    options.signal?.addEventListener('abort', () =>
      finish(() => reject(options.signal?.reason as Error)),
    )

    if (options.timeout !== undefined) {
      const ms = options.timeout
      timer = timers.set(() => finish(() => reject(new Timeout(ms))), ms)
    }

    const look = (value: T): void => {
      if (test(value)) finish(() => resolve(value))
    }

    // Waiting holds the interest for as long as it waits, and lets it go on
    // settling, failing or being abandoned.
    stop = watchValue(read, look, options.cold !== true)
    if (done) stop()
  })
}

/** Watch a formula and see every value, including the one it has right now. */
function watchValue<T>(read: () => T, see: (value: T) => void, demand = false): () => void {
  const cellOf = { get: read, peek: () => untracked(read) } as Watchable<T>
  const stop = subscribe(cellOf, see, { demand })
  // The value it already has, after the subscription exists: a source that
  // starts on the first look must have been asked before we read it.
  see(untracked(read))
  return stop
}

export type Overlap = 'drop' | 'restart' | 'queue'

export interface WheneverOptions {
  /**
   * What a change means while the handler is still busy with the last one.
   * `drop` ignores it, `restart` abandons what is running and starts again,
   * `queue` runs it after. Without a choice here, an application ends up with
   * the flags and booleans this word exists to remove.
   */
  whileRunning?: Overlap
  /**
   * Run once at the start, on the value the state already has. On by default.
   *
   * Called `atStart` and not `now`: `now` elsewhere in the library is a clock —
   * `now?: () => number`, what a command, the outbox and a kept value read the
   * time from — and one word cannot be a clock in four places and a boolean in
   * the fifth.
   */
  atStart?: boolean
  name?: string
}

export interface Standing {
  /** Whether the handler is busy right now. For a screen, and for tests. */
  readonly running: boolean
  stop(): void
}

/**
 * A handler that stands and follows the state.
 *
 * ```ts
 * whenever(
 *   () => outbox.entries.get().length,
 *   async owed => { if (owed > 0) await flush() },
 *   { whileRunning: 'drop' },
 * )
 * ```
 *
 * The body is called with the value that changed and a signal that is aborted
 * if the run is abandoned — so an async body can stop early rather than
 * finish into the void. It is registered with the enclosing region, so a
 * module that goes takes its standing handlers with it.
 */
export function whenever<T>(
  read: () => T,
  body: (value: T, signal: AbortSignal) => void | Promise<void>,
  options: WheneverOptions = {},
): Standing {
  const whileRunning = options.whileRunning ?? 'drop'
  let running = false
  let waiting: T | undefined
  let hasWaiting = false
  let abort: AbortController | undefined
  let stopped = false

  const run = (value: T): void => {
    const control = new AbortController()
    abort = control
    // A synchronous body is over by the time it returns, so it never counts as
    // busy: otherwise two writes in a row would look like an overlap and the
    // second would be dropped for no reason anybody could see.
    let answer: void | Promise<void>
    try {
      answer = body(value, control.signal)
    } catch (error) {
      abort = undefined
      throw error
    }
    if (!(answer instanceof Promise)) {
      abort = undefined
      return
    }
    running = true
    void answer
      .catch((error: unknown) => {
        // A standing handler that throws must not take the graph with it, and
        // must not go quiet either.
        queueMicrotask(() => {
          throw error
        })
      })
      .finally(() => {
        running = false
        abort = undefined
        if (stopped || !hasWaiting) return
        hasWaiting = false
        const next = waiting as T
        waiting = undefined
        // A body that throws synchronously rethrows out of `run` — and here
        // that lands inside a promise callback, where it becomes an unhandled
        // rejection: a crash in Node, a silent one in a worker. Routed the
        // same way the asynchronous branch routes its errors instead, so a
        // queued run and a direct run fail alike and the handler stands.
        try {
          run(next)
        } catch (error) {
          queueMicrotask(() => {
            throw error
          })
        }
      })
  }

  const see = (value: T): void => {
    if (stopped) return
    if (!running) {
      run(value)
      return
    }
    if (whileRunning === 'drop') return
    if (whileRunning === 'restart') {
      abort?.abort(new Error('weft: restarted by a newer value'))
      run(value)
      return
    }
    // queue: the last value wins — a handler that fell behind should catch up
    // to the present, not replay the history it missed.
    waiting = value
    hasWaiting = true
  }

  let first = true
  const stop = watchValue(read, value => {
    if (first) {
      first = false
      if (options.atStart === false) return
    }
    see(value)
  })

  const standing: Standing = {
    get running() {
      return running
    },
    stop() {
      if (stopped) return
      stopped = true
      stop()
      abort?.abort(new Error('weft: the handler was stopped'))
    },
  }

  // The enclosing region, if there is one, takes this down with itself.
  owned(() => standing.stop())
  return standing
}
