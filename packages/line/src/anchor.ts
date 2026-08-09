// Holding a row in place while the line moves under it.
//
// A live list gains and loses rows above the window, and every such move
// shifts the indices the window is positioned by — so the screen jumps under a
// reader who did not touch it. The cure is arithmetic on the line, not
// anything about React: the row a reader is looking at moved by so many
// places, so the box scrolls by exactly that many row heights and the row
// stays at the same pixel.
//
// Here rather than in the seam because that is what it is about — places along
// a measured line. The hook above is three lines of React around this.

import type { Key } from '#feed'

export interface Anchor {
  /** The row being held. */
  key: Key
  /** Where it stood when it was last seen. */
  rank: number
}

/**
 * How far the box must scroll for the held row to stay where it is, and where
 * that row stands now.
 *
 * Null when there is nothing to do: the row is gone from the ordered view, or
 * it has not moved.
 */
export function anchorShift(
  anchor: Anchor,
  rankOf: (key: Key) => number,
  rowHeight: number,
): { by: number; rank: number } | null {
  const stands = rankOf(anchor.key)
  if (stands < 0 || stands === anchor.rank) return null
  return { by: (stands - anchor.rank) * rowHeight, rank: stands }
}
