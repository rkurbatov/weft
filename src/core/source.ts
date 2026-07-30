// A source owns delivery: fetching, retrying, polling, and its own pace.
// It runs only while somebody live is watching it — demand starts it, idleness
// stops it — so an unwatched screen costs nothing.

import { input } from './graph.ts'
import type { Readable } from './graph.ts'
import { arrived, heldOf, loading, refused } from './remote.ts'
import type { Remote } from './remote.ts'

export interface Timers {
    set(fn: () => void, ms: number): unknown
    clear(handle: unknown): void
}

const wallClock: Timers = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface SourceOptions {
    name?: string
    /** Ask again this often while watched. Without it, a source loads once per demand. */
    every?: number
    /** How long an answer stays good. A new demand on a stale answer refetches. */
    shelfLife?: number
    /** Wait before a retry; doubles per failed attempt, capped by retryCap. */
    retry?: number
    retryCap?: number
    now?: () => number
    timers?: Timers
}

export interface Source<T> {
    readonly name: string
    /** The state of what the world said: empty, in flight, value with an age, refused. */
    readonly state: Readable<Remote<T>>
    /** Is anything live watching right now. */
    readonly demanded: boolean
    /**
     * Ask now, watched or not. Resolves when the answer has landed in the cell.
     * A flight already under way is ridden rather than duplicated; `force` starts
     * a new one and disowns the old answer.
     */
    refresh(options?: { force?: boolean }): Promise<void>
}

export function source<T>(load: () => Promise<T>, options: SourceOptions = {}): Source<T> {
    const name = options.name ?? 'source'
    const now = options.now ?? Date.now
    const timers = options.timers ?? wallClock
    const { every, shelfLife, retry } = options
    const retryCap = options.retryCap ?? (retry === undefined ? undefined : retry * 32)

    let timer: unknown = null
    let generation = 0
    let attempt = 0
    let inFlight: Promise<void> | null = null

    const state = input<Remote<T>>(
        { kind: 'empty' },
        {
            name,
            onDemand: () => {
                if (stale()) void begin()
                else schedule(every)
            },
            onIdle: () => {
                cancel()
            },
        },
    )

    function cancel(): void {
        if (timer === null) return
        timers.clear(timer)
        timer = null
    }

    function schedule(delay: number | undefined): void {
        cancel()
        if (delay === undefined || !state.demanded) return
        timer = timers.set(() => {
            timer = null
            void begin()
        }, delay)
    }

    /** Is what we hold too old to serve the next watcher? */
    function stale(): boolean {
        const held = heldOf(state.peek())
        if (held === undefined) return true
        if (shelfLife === undefined) return false
        return now() - held.at >= shelfLife
    }

    function backoff(): number | undefined {
        if (retry === undefined) return undefined
        const wait = retry * 2 ** Math.max(0, attempt - 1)
        return retryCap === undefined ? wait : Math.min(wait, retryCap)
    }

    function begin(force = false): Promise<void> {
        if (inFlight !== null && !force) return inFlight
        cancel()
        const mine = ++generation
        state.set(loading(state.peek(), now()))
        const run = load().then(
            value => {
                if (mine !== generation) return
                attempt = 0
                state.set(arrived(value, now()))
                schedule(every)
            },
            error => {
                if (mine !== generation) return
                attempt++
                state.set(refused(state.peek(), error, now(), attempt))
                schedule(backoff())
            },
        )
        inFlight = run.finally(() => {
            if (mine === generation) inFlight = null
        })
        return inFlight
    }

    return {
        name,
        state,
        get demanded() {
            return state.demanded
        },
        refresh: (options = {}) => begin(options.force ?? false),
    }
}