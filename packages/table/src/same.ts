// Sameness by value, not by reference.
//
// A server answering twice with the same row must not wake the screen. Deep
// enough to see through the shapes rows are actually made of, and no deeper:
// buffers, dates, plain collections, then value comparison.
//
// Bulk data — a histogram, a heat map, a column of numbers — is compared by
// value like everything else. What changed once, and matters, is how: walking
// a typed array through `Object.keys`, one property per number, cost eight
// hundred milliseconds per million on every write. The plain loop below costs
// five.
//
// Measured against the obvious alternative — eight bytes at a time through
// BigUint64Array — that one is half again faster on byte arrays and three
// times slower on number arrays, and it brings alignment, odd lengths and byte
// offsets with it. One loop for every kind of buffer is quicker where it
// matters and shorter to be wrong in.
//
// No threshold, on purpose. A rule that compared small buffers by value and
// large ones by identity would answer differently about the same data
// depending on its size — and the day a collection grew past the line, a
// screen would start redrawing for reasons nobody could find.

/** Anything backed by a buffer: typed arrays, DataView, the buffer itself. */
const isBulk = (value: object): value is ArrayBufferView | ArrayBuffer =>
  ArrayBuffer.isView(value) || value instanceof ArrayBuffer

/** Bytes of a buffer, whatever wrapper it arrived in. */
const bytesOf = (value: ArrayBufferView | ArrayBuffer): Uint8Array =>
  value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)

/** Two buffers of the same kind and length, element by element. */
function sameBulk(a: ArrayBufferView | ArrayBuffer, b: ArrayBufferView | ArrayBuffer): boolean {
  // Kind counts: the same bytes read as another type are another value.
  if (a.constructor !== b.constructor) return false
  const left = bytesOf(a)
  const right = bytesOf(b)
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false
  }
  return true
}

/**
 * Past this depth the walk starts writing down where it has been.
 *
 * A value that survives structured cloning may hold a cycle — the clone
 * algorithm tracks visited objects — so `alike` cannot treat recursion depth
 * as bounded, or a self-referencing row kills the engine with a stack
 * overflow on its first write. Tracking every pair from the start would put
 * an allocation on the hottest comparison in the library; rows are shallow,
 * so the set is bought only by the values that could actually need it. A
 * cycle cannot help crossing this depth, because a cycle is what makes depth
 * grow without end.
 */
const CYCLE_WATCH = 32

/** Structural sameness over structured-clone-shaped values. */
export function alike(a: unknown, b: unknown): boolean {
  return alikeAt(a, b, 0, undefined)
}

function alikeAt(a: unknown, b: unknown, depth: number, seen: Set<object> | undefined): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  // Buffers first: none of the shapes below fit one.
  if (isBulk(a) || isBulk(b)) return isBulk(a) && isBulk(b) && sameBulk(a, b)
  // A date has no enumerable properties, so the walk below would call any two
  // dates the same and a row where only `updatedAt` moved would never wake a
  // screen. Compared by the one value a date is.
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  }
  // The same trap: a regexp is keyless too.
  if (a instanceof RegExp || b instanceof RegExp) {
    return (
      a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags
    )
  }
  // And an error: `message` is not enumerable, so the walk below saw two
  // empty shapes — a row whose error field changed its story never woke a
  // screen. Compared by what an error means: kind, message, and its cause.
  // Not by stack — two equal errors raised in two places carry different
  // stacks, and sameness here is about meaning, not about the address.
  if (a instanceof Error || b instanceof Error) {
    return (
      a instanceof Error &&
      b instanceof Error &&
      a.name === b.name &&
      a.message === b.message &&
      alikeAt(a.cause, b.cause, depth + 1, seen)
    )
  }
  if (depth >= CYCLE_WATCH) {
    seen ??= new Set()
    // A pair already on the path above is a cycle met the second time: report
    // sameness for this link and let the rest of the walk decide — exactly
    // what the clone algorithm does when it writes a back-reference.
    if (seen.has(a)) return true
    seen.add(a)
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false
    for (const [key, value] of a) {
      if (!b.has(key) || !alikeAt(value, b.get(key), depth + 1, seen)) return false
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
    return a.every((item, i) => alikeAt(item, b[i], depth + 1, seen))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const names = Object.keys(left)
  if (names.length !== Object.keys(right).length) return false
  return names.every(n => n in right && alikeAt(left[n], right[n], depth + 1, seen))
}

export const sameItems = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((item, i) => Object.is(item, b[i]))
