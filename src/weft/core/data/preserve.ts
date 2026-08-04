// Structural sharing: rebuild a new value out of the old one wherever the two
// are the same, so an unchanged piece keeps being the very same object however
// the whole was recomputed.
//
// This is the one deliberately impure idea in the library — the same one a
// virtual DOM lives by — and it belongs to no layer in particular: a
// projection uses it, so does a mirror on the wire, so does an assembled view.
// Hence its own place at the bottom, where everything may reach for it and it
// reaches for nothing.

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
