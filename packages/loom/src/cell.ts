// One word for a cell of the graph — the same word the language uses.
//
// Underneath there are two things and they are genuinely different: one holds
// what came from outside and is written to, the other is a formula and never
// is. The dialect does not hide that difference — a formula still cannot be
// set, and the type says so — it only stops making the caller pick a word for
// it. What decides is the argument: a function is a formula, anything else is
// a value to hold.
//
// The ambiguity people fear here — "what if I want to hold a function?" — does
// not arise for us: a value must survive structural cloning to cross a worker
// boundary, and functions do not. The rule that makes this word correct was
// already in the library.
//
// The engine below calls its two primitives `stored` and `derived`, because
// there they must never be confused. Here they are one word, and it is the
// word the language uses.

import { derived, port } from '#weft'
import type { Derived, DerivedOptions, Port, PortOptions } from '#weft'

export type Cell<T> = Port<T> | Derived<T>

/** A cell holding a value: written to, and the only kind that can be. */
export function cell<T>(
  initial: T extends (...args: never[]) => unknown ? never : T,
  options?: PortOptions<T>,
): Port<T>
/** A cell worked out from others: never written to, recomputed when they move. */
export function cell<T>(formula: () => T, options?: DerivedOptions<T>): Derived<T>
export function cell<T>(arg: T | (() => T), options?: PortOptions<T> | DerivedOptions<T>): Cell<T> {
  return typeof arg === 'function'
    ? derived(arg as () => T, options as DerivedOptions<T>)
    : port(arg as T, options as PortOptions<T>)
}
