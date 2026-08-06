// Reconciliation. Something outside must match a value inside: request headers
// match the identity, a title matches the screen, a socket subscription matches
// the row on show. The rule is to watch the value itself rather than the events
// that might have changed it — then there is no list of triggers to go stale.

import { derived, port, untracked, watch } from '#graph/graph.ts'
import type { Readable } from '#graph/graph.ts'
import { wallClock } from '#graph/time.ts'
import type { Timers } from '#graph/time.ts'

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
  apply: (value: T, signal: AbortSignal) => void | Promise<void>,
  options: ReconcileOptions<T> = {},
): Reconciliation<T> {
  const name = options.name ?? 'reconcile'
  const { by, retry = 1000, maxAttempts = 5, onError } = options
  const retryCap = options.retryCap ?? retry * 32
  const timers = options.timers ?? wallClock
  const demanding = options.demand ?? false
  const atOnce = options.atOnce ?? true

  const working = port(false, { name: `${name}.working` })
  const settled = port<T | undefined>(undefined, { name: `${name}.settled` })
  const failure = port<unknown>(undefined, { name: `${name}.failed` })

  const keyOf = (value: T): unknown => (by === undefined ? value : by(value))

  let wanted: { value: T; key: unknown } | null = null
  let settledKey: unknown = Symbol('nothing')
  let running = false
  let attempt = 0
  let timer: unknown = null
  let stopped = false
  let started = false
  /**
   * The run in flight, and how to call it off. A newer value used to leave the
   * old run going: its answer was thrown away, but the request itself ran to
   * the end — traffic spent on a world state that no longer exists.
   */
  let asking: AbortController | null = null

  function abandon(why: string): void {
    if (asking === null) return
    asking.abort(new Error(`weft: ${name} — ${why}`))
    asking = null
  }

  function cancel(): void {
    if (timer === null) return
    timers.clear(timer)
    timer = null
  }

  function want(value: T): void {
    const key = keyOf(value)
    if (wanted !== null && Object.is(wanted.key, key)) return
    if (wanted === null && Object.is(settledKey, key)) return
    // What is in flight is now for a world state nobody wants.
    if (running) abandon('a newer value arrived')
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
    const controller = new AbortController()
    asking = controller
    try {
      await apply(goal.value, controller.signal)
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
      if (asking === controller) asking = null
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
    failed: derived(() => failure.get(), { name: `${name}.failed` }),
    stop: () => {
      stopped = true
      cancel()
      abandon('reconciliation stopped')
      stopWatching()
    },
  }
}
