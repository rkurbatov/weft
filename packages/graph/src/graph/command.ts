// Commands: the only way anything reaches the world. A command is started,
// awaited, and observed — its state is a cell like any other.

import { derived, stored } from './graph.ts'
import type { Stored, Readable } from './graph.ts'
import { wallClock } from './time.ts'
import type { Timers } from './time.ts'

export type CommandState<T> =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly since: number }
  | { readonly kind: 'done'; readonly value: T; readonly at: number }
  | { readonly kind: 'failed'; readonly error: unknown; readonly at: number }

/** What a second start does while the first is still in flight. */
export type WhileRunning = 'drop' | 'restart'

export interface CommandOptions {
  name?: string
  /**
   * Where a refusal goes when nobody else takes it.
   *
   * A command's failure is a value in its state, and a screen that shows it
   * needs nothing more. But a command started and not awaited — a fire and
   * forget save, a log, a background sync — used to fail into an unhandled
   * rejection or, worse, into silence. With a handler here (or a standing one
   * set by `onCommandFailure`) the refusal is always told to somebody.
   */
  onError?: (error: unknown, command: string) => void
  /** 'drop' (default) protects the world from double submits; 'restart' abandons the older answer. */
  whileRunning?: WhileRunning
  /**
   * Wait for this much quiet before actually starting. What a typing field
   * needs: the last start within the quiet wins, the ones before it never
   * happen. Sources and queries have had this from the beginning; a command
   * without it left every search box writing its own timer.
   */
  calm?: number
  timers?: Timers
  now?: () => number
}

export interface Command<A extends unknown[], T> {
  readonly name: string
  /** Start it. Returns the answer; under 'drop' a repeat start returns the one in flight. */
  run(...args: A): Promise<T>
  readonly state: Readable<CommandState<T>>
  readonly pending: Readable<boolean>
  readonly result: Readable<T | undefined>
  readonly error: Readable<unknown>
  /** Forget the last outcome; an answer still in flight is then ignored. */
  reset(): void
}

/**
 * The standing handler for refusals nobody else takes: the engine has one, and
 * commands are the other half of the same promise — nothing fails silently.
 */
let standing: ((error: unknown, command: string) => void) | undefined

export function onCommandFailure(
  handler: ((error: unknown, command: string) => void) | undefined,
): () => void {
  const before = standing
  standing = handler
  return () => {
    standing = before
  }
}

export function command<A extends unknown[], T>(
  body: (...args: A) => Promise<T>,
  options: CommandOptions = {},
): Command<A, T> {
  const name = options.name ?? 'command'
  const whileRunning = options.whileRunning ?? 'drop'
  const now = options.now ?? Date.now

  const state: Stored<CommandState<T>> = stored<CommandState<T>>(
    { kind: 'idle' },
    { name: `${name}.state` },
  )

  // Answers from abandoned attempts are ignored, never applied late.
  let generation = 0
  let inFlight: { generation: number; promise: Promise<T> } | null = null

  const settle = (generation_: number, next: CommandState<T>): void => {
    if (generation_ !== generation) return
    inFlight = null
    state.set(next)
  }

  const start = (...args: A): Promise<T> => {
    if (inFlight !== null) {
      if (whileRunning === 'drop') return inFlight.promise
      inFlight = null // 'restart': the older attempt loses its claim on the state
    }
    const mine = ++generation
    state.set({ kind: 'running', since: now() })
    const promise = (async () => {
      try {
        const value = await body(...args)
        settle(mine, { kind: 'done', value, at: now() })
        return value
      } catch (error) {
        settle(mine, { kind: 'failed', error, at: now() })
        throw error
      }
    })()
    const told = options.onError ?? standing
    if (told !== undefined) {
      // Told once, here — and this also marks the rejection as handled, so a
      // command nobody awaited does not surface as an unhandled rejection.
      promise.catch((error: unknown) => told(error, name))
    }
    inFlight = { generation: mine, promise }
    return promise
  }

  const calm = options.calm
  const timers = options.timers ?? wallClock
  let quiet: { timer: unknown; resolve: (value: T | Promise<T>) => void } | undefined

  /**
   * With no quiet asked for, a start is a start. With one, the start is held,
   * and a start arriving during the wait replaces it — the caller of the
   * replaced one gets the answer of the one that actually ran, so nobody is
   * left waiting on a promise that will never settle.
   */
  const run = (...args: A): Promise<T> => {
    if (calm === undefined) return start(...args)
    if (quiet !== undefined) timers.clear(quiet.timer)
    return new Promise<T>((resolve, reject) => {
      const waiting = quiet
      const timer = timers.set(() => {
        quiet = undefined
        const answer = start(...args)
        resolve(answer)
        waiting?.resolve(answer)
      }, calm)
      quiet = { timer, resolve: waiting === undefined ? resolve : waiting.resolve }
      if (waiting !== undefined)
        quiet.resolve = value => {
          waiting.resolve(value)
          resolve(value)
        }
      void reject
    })
  }

  return {
    name,
    run,
    state,
    pending: derived(() => state.get().kind === 'running', { name: `${name}.pending` }),
    result: derived(
      () => {
        const s = state.get()
        return s.kind === 'done' ? s.value : undefined
      },
      { name: `${name}.result` },
    ),
    error: derived(
      () => {
        const s = state.get()
        return s.kind === 'failed' ? s.error : undefined
      },
      { name: `${name}.error` },
    ),
    reset: () => {
      generation++
      inFlight = null
      state.set({ kind: 'idle' })
    },
  }
}
