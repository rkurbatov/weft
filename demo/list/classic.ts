// A long list of unequal rows, laid out the way virtualisation libraries do it.
//
// The screen needs two answers: where does row i start, and which row is at
// pixel p. Both need the sum of every height above — so libraries keep a cache
// of offsets filled in as far as anyone has looked, plus the index up to which
// it is valid. A height that changes below that mark throws the rest away
// (react-window's `resetAfterIndex`), and the next question refills it row by
// row. Insertion at the top throws away everything.
//
// This is the honest baseline: not a straw man, but what the standard tools do.

export interface List {
  /** Where row i starts, in pixels. */
  offsetOf(index: number): number
  /** Which row is at pixel p, and how far into it. */
  at(pixel: number): { index: number; into: number }
  /** A row's height changed — an image arrived, text wrapped. */
  measure(index: number, height: number): void
  /** New rows on top: a live feed pushing older ones down. */
  prepend(heights: readonly number[]): void
  size(): number
  /** How many rows had to be added up since the last reset. */
  walked(): number
  resetWalked(): void
}

export function classicList(heights: number[]): List {
  let rows = heights.slice()
  const offsets: number[] = [0]
  let measuredTo = -1 // offsets are valid for rows 0..measuredTo
  let walked = 0

  const fillTo = (index: number): void => {
    for (let i = measuredTo + 1; i <= index; i++) {
      offsets[i + 1] = (offsets[i] as number) + (rows[i] as number)
      walked++
    }
    if (index > measuredTo) measuredTo = index
  }

  return {
    offsetOf(index) {
      fillTo(index)
      return offsets[index] as number
    },

    at(pixel) {
      fillTo(rows.length - 1)
      // Binary search over the filled offsets — the part libraries do well.
      let low = 0
      let high = rows.length - 1
      while (low < high) {
        const mid = (low + high + 1) >> 1
        if ((offsets[mid] as number) <= pixel) low = mid
        else high = mid - 1
      }
      return { index: low, into: pixel - (offsets[low] as number) }
    },

    measure(index, height) {
      rows[index] = height
      // Everything below this row is now wrong.
      if (index - 1 < measuredTo) measuredTo = index - 1
    },

    prepend(fresh) {
      rows = [...fresh, ...rows]
      measuredTo = -1 // every offset moved
    },

    size: () => rows.length,
    walked: () => walked,
    resetWalked: () => {
      walked = 0
    },
  }
}
