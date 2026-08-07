// Heights for the histogram, as numbers.
//
// Separated from the markup because this is the part that can be wrong: the
// bars once rendered as nothing while the data was fine. The component that
// draws them has nothing left to get wrong.

export interface Bars {
  /** A percentage per bucket, ready to be a column height. */
  readonly heights: number[]
  /** The tallest count in the set — what the top of the plot means. */
  readonly most: number
  /** The smallest count that is not nothing — where the scale starts. */
  readonly least: number
  /** How many buckets there are, so the axis can be labelled. */
  readonly of: number
}

/**
 * Bars on a logarithmic scale.
 *
 * Latency is the reason. Most operations are quick and a few drag on, so the
 * first bucket holds twenty-two thousand matches and the tail holds five
 * hundred — and drawn linearly the tail is three pixels of nothing, which is
 * exactly the part anybody looking at latency cares about.
 *
 * A logarithm keeps the shape everyone recognises and makes the tail readable.
 * Measured from one it flattens everything instead — buckets of five hundred
 * and twenty thousand come out as sixty-three and a hundred, and the picture
 * says nothing. So the scale spans what the data actually spans: a little
 * below the smallest bucket, up to the largest.
 *
 * An empty bucket stays empty — no floor, no minimum sliver. The difference
 * between "few" and "none" is the one thing the picture must not blur.
 */
export function barHeights(hist: ArrayLike<number>): Bars {
  const values = Array.from(hist)
  const filled = values.filter(value => value > 0)
  const most = Math.max(0, ...values)
  if (filled.length === 0) {
    return { heights: values.map(() => 0), most: 0, least: 0, of: values.length }
  }

  const least = Math.min(...filled)
  // A little below the smallest, so the shortest column is a column and not a
  // line at the axis. With one bucket filled, or all of them equal, the span
  // collapses — then everything is at the top, which is the truth.
  const bottom = Math.log10(Math.max(1, least * 0.7))
  const span = Math.max(0.05, Math.log10(most) - bottom)

  return {
    heights: values.map(value =>
      value === 0 ? 0 : Math.max(4, Math.round(((Math.log10(value) - bottom) / span) * 100)),
    ),
    most,
    least,
    of: values.length,
  }
}
