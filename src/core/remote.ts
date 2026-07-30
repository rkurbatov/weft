// The state of a value that comes from outside: empty, in flight, a value with
// an age, or a refusal. One shape instead of a value plus flags beside it.

export interface Held<T> {
    readonly value: T
    readonly at: number
}

export type Remote<T> =
    | { readonly kind: 'empty' }
    | { readonly kind: 'loading'; readonly since: number; readonly held?: Held<T> }
    | { readonly kind: 'value'; readonly value: T; readonly at: number }
    | {
    readonly kind: 'failed'
    readonly error: unknown
    readonly at: number
    readonly attempt: number
    readonly held?: Held<T>
}

/** The value if there is one, including one held under a later failure or refresh. */
export function valueOf<T>(state: Remote<T>): T | undefined {
    switch (state.kind) {
        case 'value':
            return state.value
        case 'loading':
        case 'failed':
            return state.held?.value
        default:
            return undefined
    }
}

/** What is held right now, with the moment it arrived. */
export function heldOf<T>(state: Remote<T>): Held<T> | undefined {
    if (state.kind === 'value') return { value: state.value, at: state.at }
    if (state.kind === 'loading' || state.kind === 'failed') return state.held
    return undefined
}

/** How old the held value is, or undefined when nothing is held. */
export function ageOf<T>(state: Remote<T>, now: number): number | undefined {
    const held = heldOf(state)
    return held === undefined ? undefined : now - held.at
}

/** Is what we hold young enough for the caller's purpose? */
export function isFresh<T>(state: Remote<T>, within: number, now: number): boolean {
    const age = ageOf(state, now)
    return age !== undefined && age < within
}

export function isLoading<T>(state: Remote<T>): boolean {
    return state.kind === 'loading'
}

export function isFailed<T>(state: Remote<T>): boolean {
    return state.kind === 'failed'
}

/** Move to "in flight" while keeping whatever is held. */
export function loading<T>(previous: Remote<T>, since: number): Remote<T> {
    const held = heldOf(previous)
    return held === undefined ? { kind: 'loading', since } : { kind: 'loading', since, held }
}

export function arrived<T>(value: T, at: number): Remote<T> {
    return { kind: 'value', value, at }
}

export function refused<T>(previous: Remote<T>, error: unknown, at: number, attempt: number): Remote<T> {
    const held = heldOf(previous)
    return held === undefined
        ? { kind: 'failed', error, at, attempt }
        : { kind: 'failed', error, at, attempt, held }
}