// The state of a value that comes from outside: empty, in flight, a value with
// an age, or a refusal. One shape instead of a value plus flags beside it.
//
// Every variant carries the same flat fields, so a screen reads it without
// helpers: `state.value` is what to show (a flight and a refusal keep showing
// what they hold), `state.at` is when that arrived, `state.error` is the
// refusal if there is one, `state.loading` says whether an answer is on its
// way. The `kind` stays for whoever needs the exact story.

/**
 * What kind of trouble it was — named, never guessed, because the right next
 * move differs. Three are sorts of a refusal: transient passes by itself,
 * permanent will not, rejected is the world meaningfully saying no. The
 * fourth, unknown, is a different outcome altogether: the ask may have
 * reached the world and nobody knows — repeat only what is safe to repeat.
 */
export type Fault = 'transient' | 'permanent' | 'rejected' | 'unknown'

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
      readonly fault: Fault
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

export function refused<T>(
  previous: Remote<T>,
  error: unknown,
  attempt: number,
  fault: Fault,
): Remote<T> {
  const held = heldOf(previous)
  return {
    kind: 'failed',
    error,
    fault,
    attempt,
    ...(held === undefined ? {} : { held }),
    value: held?.value,
    at: held?.at,
    loading: false,
  }
}

// ── Combining outcomes ───────────────────────────────────────────────────────
// Screens rarely wait for one thing. `together` is the whole of Promise.all
// said for living values: value when every part holds, the first refusal in
// declaration order speaks for the whole (which refusal comes first is fixed
// by the order they were written in, not by which one arrived first), and the
// summary is only as old as its oldest part. `firstOf` is
// precedence among stand-ins: the first part that holds a value wins; hope
// outranks refusal among the empty-handed.

type Parts = readonly Remote<unknown>[] | Readonly<Record<string, Remote<unknown>>>

type ValuesOf<P extends Parts> = {
  -readonly [K in keyof P]: P[K] extends Remote<infer V> ? V : never
}

export function together<P extends Parts>(parts: P): Remote<ValuesOf<P>> {
  const list: readonly Remote<unknown>[] = Array.isArray(parts)
    ? (parts as readonly Remote<unknown>[])
    : Object.values(parts)

  const rebuild = (values: unknown[]): ValuesOf<P> => {
    if (Array.isArray(parts)) return values as ValuesOf<P>
    const names = Object.keys(parts)
    const record: Record<string, unknown> = {}
    names.forEach((name, i) => {
      record[name] = values[i]
    })
    return record as ValuesOf<P>
  }

  const helds: Array<Held<unknown>> = []
  let allHeld = true
  for (const part of list) {
    const h = heldOf(part)
    if (h === undefined) allHeld = false
    else helds.push(h)
  }
  const held: Held<ValuesOf<P>> | undefined =
    allHeld && list.length > 0
      ? { value: rebuild(helds.map(h => h.value)), at: Math.min(...helds.map(h => h.at)) }
      : undefined

  const bad = list.find(part => part.kind === 'failed')
  if (bad !== undefined && bad.kind === 'failed') {
    return {
      kind: 'failed',
      error: bad.error,
      fault: bad.fault,
      attempt: bad.attempt,
      ...(held === undefined ? {} : { held }),
      value: held?.value,
      at: held?.at,
      loading: false,
    }
  }

  const flights = list.filter(part => part.kind === 'loading')
  if (flights.length > 0) {
    const since = Math.min(...flights.map(part => (part.kind === 'loading' ? part.since : 0)))
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

  if (held === undefined) return EMPTY
  return { kind: 'value', value: held.value, at: held.at, error: undefined, loading: false }
}

/** The first part that holds a value wins — order is priority, not a clock.
 *  Among the empty-handed, hope outranks refusal: any flight keeps the whole
 *  in flight; only when nobody holds and nobody flies does the first refusal
 *  speak; nothing at all is nothing. */
export function firstOf<T>(...parts: ReadonlyArray<Remote<T>>): Remote<T> {
  for (const part of parts) if (heldOf(part) !== undefined) return part
  const flight = parts.find(part => part.kind === 'loading')
  if (flight !== undefined) return flight
  const bad = parts.find(part => part.kind === 'failed')
  if (bad !== undefined) return bad
  return EMPTY
}
