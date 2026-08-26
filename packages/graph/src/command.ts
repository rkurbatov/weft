// Commands: the only way anything reaches the world. A command is started,
// awaited, and observed — its state is a cell like any other.

import { derived, port } from './graph.ts'
import type { Port, Readable } from './graph.ts'
import { wallClock } from '#core'
import type { Now, Timers } from '#core'

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
  now?: Now
}

export interface Command<A extends unknown[], T> {
  readonly name: string
  /** Start it. Returns the answer; under 'drop' a repeat start returns the one in flight. */
  run(...args: A): Promise<T>
  readonly state: Readable<CommandState<T>>
  readonly pending: Readable<boolean>
  readonly result: Readable<T | undefined>
  readonly error: Readable<unknown>
  /**
   * Forget the last outcome; an answer still in flight is then ignored. A
   * start still waiting out `calm` never happens at all, and its callers are
   * refused with `CommandReset` rather than left waiting.
   *
   * The two halves are deliberately different, and the difference is what can
   * still be undone: a start that has not begun is taken back, while one
   * already in the world runs to its end and only loses its claim on the
   * state. Calling a running command off is a different thing and is not this.
   */
  reset(): void
}

/**
 * What a start still waiting out `calm` is refused with when the command is
 * reset. A type rather than a sentence, so an application can tell "the world
 * said no" from "this start was taken back before it happened".
 */
export class CommandReset extends Error {
  override readonly name = 'CommandReset'

  constructor(command: string) {
    super(`weft: ${command} was reset before it started`)
  }
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

  const state: Port<CommandState<T>> = port<CommandState<T>>(
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
  interface Waiter {
    promise: Promise<T>
    resolve: (value: T | Promise<T>) => void
    reject: (error: unknown) => void
  }
  /** The start being held, and everybody waiting on it. */
  interface Quiet {
    timer: unknown
    args: A
    waiters: Waiter[]
  }
  let quiet: Quiet | undefined

  /**
   * With no quiet asked for, a start is a start. With one, the start is held,
   * and a start arriving during the wait replaces it — the caller of the
   * replaced one gets the answer of the one that actually ran, so nobody is
   * left waiting on a promise that will never settle.
   */
  const run = (...args: A): Promise<T> => {
    if (calm === undefined) return start(...args)
    let settle!: Waiter
    const promise = new Promise<T>((resolve, reject) => {
      settle = { promise: undefined as unknown as Promise<T>, resolve, reject }
    })
    settle.promise = promise
    // A flat list rather than a chain of resolves calling resolves: the chain
    // was one frame per caller, and a search box that fired twenty thousand
    // times inside one quiet blew the stack when the wait ran out.
    if (quiet === undefined) quiet = { timer: undefined, args, waiters: [settle] }
    else {
      timers.clear(quiet.timer)
      quiet.args = args
      quiet.waiters.push(settle)
    }
    const held = quiet
    held.timer = timers.set(() => {
      quiet = undefined
      // The last start within the quiet is the one that runs, and everybody
      // who asked gets its answer — nobody is left on a promise that will
      // never settle.
      const answer = start(...held.args)
      // Whether a refusal by the world reaches the host as an unhandled
      // rejection must not depend on whether a quiet was asked for. `start`
      // marks its own promise handled when somebody is there to be told; the
      // promises handed to the callers waiting here are other promises, and
      // they are marked on the same condition and no other.
      const told = options.onError ?? standing
      for (const waiter of held.waiters) {
        waiter.resolve(answer)
        if (told !== undefined) waiter.promise.catch(() => {})
      }
    }, calm)
    return promise
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
      // A start still waiting out its quiet has not happened yet, so this
      // takes it back rather than forgetting it: the timer went with the
      // state, or the body ran a moment later into a command that says it is
      // idle, and callers on the wait were left holding a promise that would
      // never settle.
      if (quiet !== undefined) {
        const held = quiet
        quiet = undefined
        timers.clear(held.timer)
        const taken = new CommandReset(name)
        for (const waiter of held.waiters) {
          // The library's own doing, told to nobody: a caller who awaited sees
          // it, one who did not is not made to meet it as an unhandled
          // rejection. A refusal by the world is left alone — it goes to
          // `onError` and to the state, exactly as it does without `calm`.
          waiter.promise.catch(() => {})
          waiter.reject(taken)
        }
      }
      state.set({ kind: 'idle' })
    },
  }
}