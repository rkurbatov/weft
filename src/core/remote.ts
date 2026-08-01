// The state of a value that comes from outside: empty, in flight, a value with
// an age, or a refusal. One shape instead of a value plus flags beside it.
//
// Every variant carries the same flat fields, so a screen reads it without
// helpers: `state.value` is what to show (a flight and a refusal keep showing
// what they hold), `state.at` is when that arrived, `state.error` is the
// refusal if there is one, `state.loading` says whether an answer is on its
// way. The `kind` stays for whoever needs the exact story.

export interface Held<T> {
  readonly value: T
  readonly at: number
}

export type Remote<T> =
  | {
      readonly kind: 'empty'
      readonly value: undefined
      readonly at: undefined
      readonly error: undefined
      readonly loading: false
    }
  | {
      readonly kind: 'loading'
      readonly since: number
      readonly held?: Held<T>
      readonly value: T | undefined
      readonly at: number | undefined
      readonly error: undefined
      readonly loading: true
    }
  | {
      readonly kind: 'value'
      readonly value: T
      readonly at: number
      readonly error: undefined
      readonly loading: false
    }
  | {
      readonly kind: 'failed'
      readonly error: unknown
      readonly attempt: number
      readonly held?: Held<T>
      readonly value: T | undefined
      readonly at: number | undefined
      readonly loading: false
    }

export const EMPTY: Remote<never> = {
  kind: 'empty',
  value: undefined,
  at: undefined,
  error: undefined,
  loading: false,
}

/** What is held right now, with the moment it arrived. Exact where `value`
 *  would be ambiguous — a held `undefined` and nothing held read the same. */
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

/** Move to "in flight" while keeping whatever is held. */
export function loading<T>(previous: Remote<T>, since: number): Remote<T> {
  const held = heldOf(previous)
  return {
    kind: 'loading',
    since,
    ...(held === undefined ? {} : { held }),
    value: held?.value,
    at: held?.at,
    error: undefined,
    loading: true,
  }
}

export function arrived<T>(value: T, at: number): Remote<T> {
  return { kind: 'value', value, at, error: undefined, loading: false }
}

export function refused<T>(previous: Remote<T>, error: unknown, attempt: number): Remote<T> {
  const held = heldOf(previous)
  return {
    kind: 'failed',
    error,
    attempt,
    ...(held === undefined ? {} : { held }),
    value: held?.value,
    at: held?.at,
    loading: false,
  }
}
