// A list as part of a form: filtered, ordered, windowed — and shelves taken
// from the values of a field rather than written out one by one.

import { derived } from '#weft'
import type { Key, Watchable } from '#weft'
import type { Feed } from './feed.ts'
import type { FieldType, ScalarField } from './fields.ts'
import type { Part } from './shape.ts'

export interface ListView<R> {
  /** The rows of the window, in order. Wakes only when the window itself moves. */
  rows: Watchable<readonly R[]>
  /** How many rows there are in all — the scrollbar's number, not the window's. */
  size: Watchable<number>
  /** A window of one's own, for a screen that decides its own bounds. */
  window: (from: number, to: number) => Watchable<readonly R[]>
  /** Where a row stands in the order, or -1 when it is not in this list. */
  place: (key: Key) => number
}

export interface ListSpec<R> {
  /** Which rows belong here. A formula may decide, and then the list follows it. */
  where?: (row: R) => boolean
  /** The order. A field name, or a comparison of your own. */
  order: ScalarField<R> | ((a: R, b: R) => number)
  /** Latest first for a field order. */
  down?: boolean
  /**
   * The window a screen actually shows. Both ends may be live: scrolling moves
   * a cell, and only the window's own rows wake. Without a window the whole
   * list is the answer, which is right for a shelf of twenty and wrong for a
   * shelf of a hundred thousand.
   */
  window?: { from: Watchable<number>; size: number }
}

/**
 * A list as part of a form: filtered, ordered, and windowed.
 *
 * Groups answer with their rows, which is right while a group is small. A
 * shelf a person scrolls is not small, and its answer is the window — so it is
 * stated here rather than left to the caller to slice afterwards.
 */
export function list<R>(feed: Feed<R>, spec: ListSpec<R>): Part<ListView<R>> {
  return {
    build(name) {
      const part = spec.where === undefined ? feed : feed.only(spec.where, `${name}.only`)
      const compare =
        typeof spec.order === 'function'
          ? spec.order
          : (a: R, b: R): number => {
              const left = a[spec.order as keyof R]
              const right = b[spec.order as keyof R]
              const sign = left === right ? 0 : left < right ? -1 : 1
              return spec.down === true ? -sign : sign
            }
      const sorted = part.sortedBy(compare, `${name}.order`)
      const window = spec.window
      const rows =
        window === undefined
          ? derived(() => part.rows.get(), { name: `${name}.rows` })
          : derived(() => sorted.window(window.from.get(), window.from.get() + window.size).get(), {
              name: `${name}.window`,
            })
      return {
        rows,
        size: sorted.size,
        window: (from, to) => sorted.window(from, to),
        place: sorted.place,
      }
    },
  }
}

/**
 * One list per value of a field: the shelves of a screen, taken from the data
 * rather than written out.
 *
 * Four shelves by status used to be four predicates and the same order spelled
 * four times, and adding a status meant editing the screen. Here the field is
 * named once; a shelf is built the first time it is asked for and kept after,
 * so a value nobody looks at costs nothing.
 */
export function listsBy<R, F extends ScalarField<R>, Whole extends string = never>(
  feed: Feed<R>,
  field: F,
  spec: Omit<ListSpec<R>, 'where'> & {
    /**
     * A shelf holding everything, under this name, beside the ones the field
     * gives. Screens nearly always want it, and building it here keeps the
     * whole set in one place — a shelf is a shelf, whether a field named it or
     * not.
     */
    whole?: Whole
  },
): Part<Record<Extract<FieldType<R, F>, string | number> | Whole, ListView<R>>> {
  return {
    build(name) {
      const shelves = new Map<string, ListView<R>>()
      const shelfFor = (value: string): ListView<R> => {
        const standing = shelves.get(value)
        if (standing !== undefined) return standing
        const made = list(
          feed,
          value === spec.whole
            ? spec
            : { ...spec, where: row => String(row[field as unknown as keyof R]) === value },
        ).build(`${name}.${value}`)
        shelves.set(value, made)
        return made
      }
      // A proxy, so the set of shelves is the DATA's business, not the
      // code's. The type names the keys the field can hold, but the values
      // actually arriving decide which shelves exist: a status added to the
      // corpus tomorrow gets its window on first access with no edit here or
      // on the screen — and a status nobody's screen asks for never builds
      // one, so the price tracks what is shown, not what is possible.
      return new Proxy(
        {},
        {
          get: (_target, key) => (typeof key === 'string' ? shelfFor(key) : undefined),
          has: () => true,
          ownKeys: () => [...shelves.keys()],
          getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
        },
      ) as Record<Extract<FieldType<R, F>, string | number> | Whole, ListView<R>>
    },
  }
}
