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

export function preserve<T>(prev: T, next: T, limit: number = PRESERVE_LIMIT): T {
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
  if (prev instanceof Map || next instanceof Map) {
    if (!(prev instanceof Map) || !(next instanceof Map)) return next
    if (tooBig((next as Map<unknown, unknown>).size, limit)) return next
    const merged = new Map<unknown, unknown>()
    let same = prev.size === next.size
    for (const [key, value] of next as Map<unknown, unknown>) {
      const kept = (prev as Map<unknown, unknown>).has(key)
        ? preserve((prev as Map<unknown, unknown>).get(key), value, limit)
        : value
      merged.set(key, kept)
      if (!Object.is(kept, (prev as Map<unknown, unknown>).get(key))) same = false
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
    const merged = next.map((item, i) => (i < prev.length ? preserve(prev[i], item, limit) : item))
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
    const kept = name in before ? preserve(before[name], after[name], limit) : after[name]
    merged[name] = kept
    if (!Object.is(kept, before[name])) same = false
  }
  return (same ? prev : merged) as T
}
