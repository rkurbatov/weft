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

/** Structural sameness over JSON-shaped values. */
export function alike(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  // Buffers first: none of the shapes below fit one.
  if (isBulk(a) || isBulk(b)) return isBulk(a) && isBulk(b) && sameBulk(a, b)
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
