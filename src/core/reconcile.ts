// Reconciliation. Something outside must match a value inside: request headers
// match the identity, a title matches the screen, a socket subscription matches
// the row on show. The rule is to watch the value itself rather than the events
// that might have changed it — then there is no list of triggers to go stale.

import { cell, input, untracked, watch } from './graph.ts'
import type { Readable } from './graph.ts'
import { wallClock } from './time.ts'
import type { Timers } from './time.ts'

export interface ReconcileOptions<T> {
  name?: string
  /** Compare by this rather than by the value itself. */
  by?: (value: T) => unknown
  /**
   * Whether following counts as asking. Off by default: reconciliation follows
   * what happens anyway and does not keep a source awake on its own.
   */
  demand?: boolean
  /** Bring the world in line straight away, not from the next change onward. Default true. */
  atOnce?: boolean
  /** Wait before trying again after a refusal; doubles per attempt, capped by retryCap. */
  retry?: number
  retryCap?: number
  /** After this many refusals it gives up on that value and waits for the next one. */
  maxAttempts?: number
  onError?: (error: unknown, value: T) => void
  timers?: Timers
}

export interface Reconciliation<T> {
  readonly name: string
  /** Is the world being brought in line right now. */
  readonly working: Readable<boolean>
  /** The value the world was last brought to. */
  readonly settled: Readable<T | undefined>
  /** The refusal that stopped the last attempt, if it gave up. */
  readonly failed: Readable<unknown>
  stop(): void
}

export function reconcile<T>(
  target: Readable<T>,
  apply: (value: T) => void | Promise<void>,
  options: ReconcileOptions<T> = {},
): Reconciliation<T> {
  const name = options.name ?? 'reconcile'
  const { by, retry = 1000, maxAttempts = 5, onError } = options
  const retryCap = options.retryCap ?? retry * 32
  const timers = options.timers ?? wallClock
  const demanding = options.demand ?? false
  const atOnce = options.atOnce ?? true

  const working = input(false, { name: `${name}.working` })
  const settled = input<T | undefined>(undefined, { name: `${name}.settled` })
  const failure = input<unknown>(undefined, { name: `${name}.failed` })

  const keyOf = (value: T): unknown => (by === undefined ? value : by(value))

  let wanted: { value: T; key: unknown } | null = null
  let settledKey: unknown = Symbol('nothing')
  let running = false
  let attempt = 0
  let timer: unknown = null
  let stopped = false
  let started = false

  function cancel(): void {
    if (timer === null) return
    timers.clear(timer)
    timer = null
  }

  function want(value: T): void {
    const key = keyOf(value)
    if (wanted !== null && Object.is(wanted.key, key)) return
    if (wanted === null && Object.is(settledKey, key)) return
    wanted = { value, key }
    attempt = 0
    failure.set(undefined)
    cancel()
    void pump()
  }

  async function pump(): Promise<void> {
    if (running || stopped || wanted === null) return
    const goal = wanted
    running = true
    working.set(true)
    attempt++
    try {
      await apply(goal.value)
      if (stopped) return
      // A newer goal may have arrived while this one was being applied; only
      // the latest matters, the ones in between were never the world's state.
      if (wanted === goal) {
        wanted = null
        settledKey = goal.key
        settled.set(goal.value)
        attempt = 0
      }
    } catch (error) {
      if (stopped) return
      onError?.(error, goal.value)
      if (wanted === goal && attempt >= maxAttempts) {
        wanted = null
        failure.set(error)
      } else if (wanted === goal) {
        timer = timers.set(
          () => {
            timer = null
            void pump()
          },
          Math.min(retry * 2 ** Math.max(0, attempt - 1), retryCap),
        )
      }
    } finally {
      running = false
      working.set(wanted !== null)
    }
    if (timer === null) void pump()
  }

  const stopWatching = watch(
    () => {
      const value = target.get()
      untracked(() => {
        if (!started) {
          started = true
          if (!atOnce) {
            settledKey = keyOf(value)
            return
          }
        }
        want(value)
      })
    },
    { demand: demanding },
  )

  return {
    name,
    working,
    settled,
    failed: cell(() => failure.get(), { name: `${name}.failed` }),
    stop: () => {
      stopped = true
      cancel()
      stopWatching()
    },
  }
}
