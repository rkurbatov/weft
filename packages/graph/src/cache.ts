// The two policies the caches in this library provably share: what a primitive
// key is called, and what counts as a ceiling. Not a shared cache — the way a
// family and a query let a member go has nothing in common, and pretending
// otherwise would be the wrong abstraction. These two are pure and were
// already living in two copies, which is how they came apart once.

/**
 * How a primitive key becomes the name a cache holds it under. The kind is
 * part of it: `1` and `'1'`, `true` and `'true'`, `1` and `1n` are different
 * questions, and a cache that answered one of them with the other's member
 * would be quietly wrong.
 *
 * Without a name of the caller's own, `string | number | boolean | bigint` are
 * held as they are; everything else — objects, symbols, functions, undefined —
 * needs one, because there is no honest name for them here.
 */
export function nameOfKey(key: unknown, who: string, option: string): string {
  const kind = typeof key
  if (kind === 'string' || kind === 'number' || kind === 'boolean' || kind === 'bigint') {
    return `${kind}:${String(key)}`
  }
  throw new TypeError(`weft: ${who} needs ${option} for ${kind} keys`)
}

/**
 * A ceiling is a count of things held, so it is a finite, safe, whole number
 * of them and not fewer than none. Safe matters as much as whole: past
 * `Number.MAX_SAFE_INTEGER` the arithmetic a cache does on its own size stops
 * being exact, and a ceiling that cannot be counted up to is not a ceiling.
 *
 * Anything else was quietly doing something: a fraction and a negative both
 * happened to keep one member, `NaN` compared false against everything and
 * kept one too, and `Infinity` turned a bounded cache unbounded without ever
 * saying the word. Where a cache means to offer no ceiling at all it says so
 * in words, and the word is checked before this is.
 */
export function ceiling(max: number, who: string): number {
  if (!Number.isSafeInteger(max) || max < 0) {
    throw new RangeError(
      `weft: ${who} needs a finite, safe, whole ceiling of none or more, not ${String(max)}`,
    )
  }
  return max
}
