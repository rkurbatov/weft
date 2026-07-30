// Commands: the only way anything reaches the world. A command is started,
// awaited, and observed — its state is a cell like any other.

import { input, cell } from './graph.ts'
import type { Input, Readable } from './graph.ts'

export type CommandState<T> =
    | { readonly kind: 'idle' }
    | { readonly kind: 'running'; readonly since: number }
    | { readonly kind: 'done'; readonly value: T; readonly at: number }
    | { readonly kind: 'failed'; readonly error: unknown; readonly at: number }

/** What a second start does while the first is still in flight. */
export type WhileRunning = 'drop' | 'restart'

export interface CommandOptions {
    name?: string
    /** 'drop' (default) protects the world from double submits; 'restart' abandons the older answer. */
    whileRunning?: WhileRunning
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

export function command<A extends unknown[], T>(
    body: (...args: A) => Promise<T>,
    options: CommandOptions = {},
): Command<A, T> {
    const name = options.name ?? 'command'
    const whileRunning = options.whileRunning ?? 'drop'
    const now = options.now ?? Date.now

    const state: Input<CommandState<T>> = input<CommandState<T>>(
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

    const run = (...args: A): Promise<T> => {
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
        inFlight = { generation: mine, promise }
        return promise
    }

    return {
        name,
        run,
        state,
        pending: cell(() => state.get().kind === 'running', { name: `${name}.pending` }),
        result: cell(
            () => {
                const s = state.get()
                return s.kind === 'done' ? s.value : undefined
            },
            { name: `${name}.result` },
        ),
        error: cell(
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