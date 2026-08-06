// Sameness by value, not by reference.
//
// A server answering twice with the same row must not wake the screen. Deep
// enough to see through the shapes rows are actually made of, and no deeper:
// dates and plain collections, then value comparison.

/** Structural sameness over JSON-shaped values. */
export function alike(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false
    for (const [key, value] of a) {
      if (!b.has(key) || !alike(value, b.get(key))) return false
    }
    return true
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false
    for (const item of a) if (!b.has(item)) return false
    return true
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => alike(item, b[i]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const names = Object.keys(left)
  if (names.length !== Object.keys(right).length) return false
  return names.every(n => n in right && alike(left[n], right[n]))
}

export const sameItems = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((item, i) => Object.is(item, b[i]))
