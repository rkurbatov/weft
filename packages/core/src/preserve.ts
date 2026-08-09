// Structural sharing: rebuild a new value out of the old one wherever the two
// are the same, so an unchanged piece keeps being the very same object however
// the whole was recomputed.
//
// This is the one deliberately impure idea in the library — the same one a
// virtual DOM lives by — and it belongs to no layer in particular: a
// projection uses it, so does a mirror on the wire, so does an assembled view.
// Hence its own place at the bottom, where everything may reach for it and it
// reaches for nothing.

import { notice } from './notice.ts'

/**
 * How large a collection may be before it is left alone.
 *
 * Keeping identity costs a walk of everything: for a map of ten thousand rows,
 * every recompute compares ten thousand entries to save the few that changed.
 * Past this size the new value is handed back whole — a screen that needs
 * per-row stability over a collection this big should hold a table, where a
 * change is a change of one row, not a map in a cell.
 *
 * Announced rather than silent: it goes out on the notice channel, the same
 * one the planner's decisions go out on.
 */
export const PRESERVE_LIMIT = 4096

/** For a caller that knows its own collection: pass a limit of its own. */

const tooBig = (size: number, limit: number): boolean => {
  if (size <= limit) return false
  notice({
    kind: 'wholesale',
    where: 'preserve',
    level: 'warn',
    message:
      `a collection of ${size} is past the ${limit} that identity is kept for, so it is ` +
      `handed on whole and memoised screens over it will redraw. Hold rows in a table ` +
      `rather than a map in a cell, or raise the limit for this call.`,
    detail: { size, limit },
  })
  return true
}

/** Anything backed by a buffer: a million numbers are not a million fields. */
const isBulk = (value: object): boolean => ArrayBuffer.isView(value) || value instanceof ArrayBuffer

/**
 * Past this depth the walk starts writing down where it has been — the same
 * guard, for the same reason, as the equality walk in the table layer: a
 * value that survives structured cloning may hold a cycle, and a depth-first
 * walk without a visited set dies on it by stack overflow. Rows are shallow,
 * so the set is bought only by values that could actually need it; a cycle
 * cannot help crossing this depth, because a cycle is what makes depth grow
 * without end.
 */
const CYCLE_WATCH = 32

export function preserve<T>(prev: T, next: T, limit: number = PRESERVE_LIMIT): T {
  return preserveAt(prev, next, limit, 0, undefined)
}

function preserveAt<T>(
  prev: T,
  next: T,
  limit: number,
  depth: number,
  seen: Set<object> | undefined,
): T {
  if (Object.is(prev, next)) return next
  // Bulk data is handed on as it is. Not for speed — comparing it is cheap —
  // but because there is nothing inside a buffer whose identity could be kept:
  // it holds numbers, not objects, and the only identity it has is its own.
  if (
    typeof prev === 'object' &&
    prev !== null &&
    typeof next === 'object' &&
    next !== null &&
    (isBulk(prev) || isBulk(next))
  ) {
    return next
  }
  if (typeof prev !== 'object' || typeof next !== 'object' || prev === null || next === null)
    return next
  // A date has no enumerable properties, so the object walk below would call
  // any two dates the same — and hand back the OLD one when only a timestamp
  // moved. A date is its one value: same instant, keep the old identity;
  // another instant, take the new object.
  if (prev instanceof Date || next instanceof Date) {
    if (!(prev instanceof Date) || !(next instanceof Date)) return next
    return (prev.getTime() === next.getTime() ? prev : next) as T
  }
  if (prev instanceof RegExp || next instanceof RegExp) {
    if (!(prev instanceof RegExp) || !(next instanceof RegExp)) return next
    return (prev.source === next.source && prev.flags === next.flags ? prev : next) as T
  }
  // An error is keyless the same way: two different stories read as two
  // empty shapes, and the walk would keep the old one. Same story — same
  // object; another story — the new one. The stack does not count, for the
  // reason it does not count in `alike`.
  if (prev instanceof Error || next instanceof Error) {
    if (!(prev instanceof Error) || !(next instanceof Error)) return next
    const same =
      prev.name === next.name &&
      prev.message === next.message &&
      Object.is(preserveAt(prev.cause, next.cause, limit, depth + 1, seen), prev.cause)
    return (same ? prev : next) as T
  }
  if (depth >= CYCLE_WATCH) {
    seen ??= new Set()
    // A pair met the second time on this path is a cycle: descending again
    // never ends. The new value is handed back as it is — identity is not
    // kept inside a cycle, which costs a redraw and no correctness.
    if (seen.has(prev as object)) return next
    seen.add(prev as object)
  }
  if (prev instanceof Map || next instanceof Map) {
    if (!(prev instanceof Map) || !(next instanceof Map)) return next
    if (tooBig((next as Map<unknown, unknown>).size, limit)) return next
    const merged = new Map<unknown, unknown>()
    let same = prev.size === next.size
    for (const [key, value] of next as Map<unknown, unknown>) {
      const had = (prev as Map<unknown, unknown>).has(key)
      const kept = had
        ? preserveAt((prev as Map<unknown, unknown>).get(key), value, limit, depth + 1, seen)
        : value
      merged.set(key, kept)
      // Presence first: a key the old map lacked reads as `undefined` too, and
      // a new entry holding `undefined` would otherwise count as no change —
      // the old map would be handed back with the entry missing.
      if (!had || !Object.is(kept, (prev as Map<unknown, unknown>).get(key))) same = false
    }
    return (same ? prev : merged) as T
  }
  if (prev instanceof Set || next instanceof Set) {
    if (!(prev instanceof Set) || !(next instanceof Set)) return next
    if (tooBig((next as Set<unknown>).size, limit)) return next
    if (prev.size === next.size && [...next].every(item => (prev as Set<unknown>).has(item)))
      return prev as T
    return next
  }
  if (Array.isArray(prev) || Array.isArray(next)) {
    if (!Array.isArray(prev) || !Array.isArray(next)) return next
    if (tooBig(next.length, limit)) return next
    const merged = next.map((item, i) =>
      i < prev.length ? preserveAt(prev[i], item, limit, depth + 1, seen) : item,
    )
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
    const had = name in before
    const kept = had ? preserveAt(before[name], after[name], limit, depth + 1, seen) : after[name]
    merged[name] = kept
    // Presence first, as with maps: a key the old object lacked also reads as
    // `undefined`, so a fresh `x: undefined` matched the void and the OLD
    // object came back — a schema change swallowed whole.
    if (!had || !Object.is(kept, before[name])) same = false
  }
  return (same ? prev : merged) as T
}
