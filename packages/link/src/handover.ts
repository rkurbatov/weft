// Values that are handed over rather than copied.
//
// Measured before it was built. At ten sends a second: under a megabyte,
// copying costs nothing worth naming; eight megabytes take four percent of the
// budget; thirty take nineteen. Handing ownership over is almost free at any
// size — but the buffer is empty on this side afterwards, and a cell is
// something anybody may read again.
//
// So this is a declaration, not a decision the library may take for itself.
// The application says "this value is one-off, give it away", and it says so
// about the value rather than about the cell: the same cell may publish a
// result that is given away and, later, one it keeps.
//
// It is deliberately not left to the planner. The planner chooses how, never
// what the answer is — and handing a buffer over changes what the sender holds
// afterwards. A choice by size would mean a small histogram survives in the
// graph and a large one vanishes, with nothing on the page to explain it.

/** A value wrapped for sending: hand these buffers over, do not copy them. */
export interface HandedOver<T> {
  readonly weft: 'handOver'
  readonly value: T
  readonly buffers: readonly ArrayBufferLike[]
}

/**
 * Say that this value is one-off and its buffers may be given away.
 *
 * The buffers are found in the value itself — typed arrays, views, plain
 * buffers, and the same nested one level down inside a plain object or array,
 * which is where a histogram beside its labels lives.
 */
export function handOver<T>(value: T): HandedOver<T> {
  return { weft: 'handOver', value, buffers: buffersOf(value) }
}

/** Whether a value was wrapped for handing over. */
export const handedOver = (value: unknown): value is HandedOver<unknown> =>
  typeof value === 'object' && value !== null && (value as { weft?: string }).weft === 'handOver'

/** Buffers inside a value: itself, its fields, or its items — one level down. */
function buffersOf(value: unknown, depth = 1): ArrayBufferLike[] {
  if (value instanceof ArrayBuffer) return [value]
  if (ArrayBuffer.isView(value)) return [value.buffer]
  if (depth === 0 || typeof value !== 'object' || value === null) return []

  const found: ArrayBufferLike[] = []
  const parts = Array.isArray(value) ? value : Object.values(value)
  for (const part of parts) {
    for (const buffer of buffersOf(part, depth - 1)) found.push(buffer)
  }
  // The same buffer twice would be refused by the wire, and a view of a view is
  // an ordinary thing to build.
  return [...new Set(found)]
}
