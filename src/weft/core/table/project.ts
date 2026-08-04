// Projection: the base plus the replay of the book, as one derived value.
// The app states what each note does to the state — one line per kind — and
// everything else is the library's business: replay order, skipping the
// stuck, and keeping the identity of unchanged pieces so a memoized screen
// stays quiet. The identity keeping is the one deliberately impure spot, and
// it lives here, under the floor, not in application formulas.

import { cell } from '../graph/graph.ts'
import type { Cell, Watchable } from '../graph/graph.ts'
import type { Entry } from '../keep/outbox.ts'

/**
 * Rebuild `next` out of `prev` wherever the two are structurally the same:
 * an unchanged piece keeps being the very same object, however the whole was
 * recomputed. Arrays match by index, plain objects by key.
 */
export function preserve<T>(prev: T, next: T): T {
  if (Object.is(prev, next)) return next
  if (typeof prev !== 'object' || typeof next !== 'object' || prev === null || next === null)
    return next
  if (prev instanceof Map || next instanceof Map) {
    if (!(prev instanceof Map) || !(next instanceof Map)) return next
    const merged = new Map<unknown, unknown>()
    let same = prev.size === next.size
    for (const [key, value] of next as Map<unknown, unknown>) {
      const kept = (prev as Map<unknown, unknown>).has(key)
        ? preserve((prev as Map<unknown, unknown>).get(key), value)
        : value
      merged.set(key, kept)
      if (!Object.is(kept, (prev as Map<unknown, unknown>).get(key))) same = false
    }
    return (same ? prev : merged) as T
  }
  if (prev instanceof Set || next instanceof Set) {
    if (!(prev instanceof Set) || !(next instanceof Set)) return next
    if (prev.size === next.size && [...next].every(item => (prev as Set<unknown>).has(item)))
      return prev as T
    return next
  }
  if (Array.isArray(prev) || Array.isArray(next)) {
    if (!Array.isArray(prev) || !Array.isArray(next)) return next
    const merged = next.map((item, i) => (i < prev.length ? preserve(prev[i], item) : item))
    return (
      merged.length === prev.length && merged.every((item, i) => Object.is(item, prev[i]))
        ? prev
        : merged
    ) as T
  }
  const before = prev as Record<string, unknown>
  const after = next as Record<string, unknown>
  const names = Object.keys(after)
  const merged: Record<string, unknown> = {}
  let same = names.length === Object.keys(before).length
  for (const name of names) {
    const kept = name in before ? preserve(before[name], after[name]) : after[name]
    merged[name] = kept
    if (!Object.is(kept, before[name])) same = false
  }
  return (same ? prev : merged) as T
}

export interface ProjectionSpec<S> {
  /** What a note of each kind does to the state. Unknown kinds pass through. */
  apply: Record<string, (state: S, args: never) => S>
  name?: string
}

/**
 * The visible state: base plus the book laid over it, in book order. Rollback
 * does not exist here — a refused note leaves the book, and the projection
 * recomputes without it. Identity of unchanged pieces is preserved, so
 * `React.memo` and equality gates keep working across replays and reloads.
 */
export function projected<S>(
  base: Watchable<S>,
  book: Watchable<readonly Entry[]>,
  spec: ProjectionSpec<S>,
): Cell<S> {
  let previous: S | undefined
  return cell<S>(
    () => {
      const start = base.get()
      const laid = book.get().reduce((state, entry) => {
        if (entry.state === 'stuck') return state
        const apply = spec.apply[entry.name]
        return apply === undefined ? state : apply(state, entry.args as never)
      }, start)
      const kept = previous === undefined ? laid : preserve(previous, laid)
      previous = kept
      return kept
    },
    { name: spec.name ?? 'projected' },
  )
}
