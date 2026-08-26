// A list as part of a form: filtered, ordered, windowed — and shelves taken
// from the values of a field rather than written out one by one.

import { notice } from '#core'
import { derived } from '#weft'
import type { Key, Watchable } from '#weft'
import type { Live } from './live.ts'
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
  /** Is anybody looking? What nobody holds may be let go of. */
  readonly watched: boolean
  /** Let go of the filter and the order built for this list. */
  dispose: () => void
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
export function list<R>(feed: Live<R>, spec: ListSpec<R>): Part<ListView<R>> {
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
          ? // The sorted view, not the source. Reading the source here meant a
            // list with an order and no window handed back the rows in
            // whatever order the feed held them — an order was asked for, one
            // was built, and nobody read it.
            derived(() => sorted.rows.get(), { name: `${name}.rows` })
          : derived(() => sorted.window(window.from.get(), window.from.get() + window.size).get(), {
              name: `${name}.window`,
            })
      // Everything this list has handed out. Watching ANY of it is watching
      // the list: a screen that shows a count and no rows — a tab with a
      // number on it — holds `size` and nothing else, and a ceiling that
      // looked only at `rows` would call that shelf idle and take it away
      // from under it.
      const handed = new Set<Watchable<unknown>>([rows, sorted.size])
      return {
        rows,
        size: sorted.size,
        window: (from, to) => {
          const seen = sorted.window(from, to)
          handed.add(seen)
          return seen
        },
        place: sorted.place,
        get watched() {
          for (const one of handed) {
            if ((one as { demanded?: boolean }).demanded === true) return true
          }
          return false
        },
        dispose() {
          rows.dispose()
          sorted.dispose()
          // Only what this list built: a filter of its own, never the feed it
          // was taken from.
          if (part !== feed) part.dispose()
        },
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
  feed: Live<R>,
  field: F,
  spec: Omit<ListSpec<R>, 'where'> & {
    /**
     * A shelf holding everything, under this name, beside the ones the field
     * gives. Screens nearly always want it, and building it here keeps the
     * whole set in one place — a shelf is a shelf, whether a field named it or
     * not.
     */
    whole?: Whole
    /**
     * How many shelves to keep. Grouping by a field with few values — a status,
     * a lane — never reaches it; grouping by one with a value per row would
     * otherwise keep a window per row for as long as the screen lives.
     */
    keep?: number
  },
): Part<Record<Extract<FieldType<R, F>, string | number> | Whole, ListView<R>>> {
  const keep = spec.keep ?? 32
  return {
    build(name) {
      /** Insertion order is the age order, which is what the ceiling goes by. */
      const shelves = new Map<string, ListView<R>>()

      /**
       * Drop the oldest shelves nobody is holding.
       *
       * Three things this has to get right, each of which it got wrong once.
       * The standing shelf is skipped rather than stopping the search — a
       * screen reads its totals first, so `whole` was usually the oldest key
       * and the ceiling was switched off from the first look. A shelf somebody
       * is watching is never dropped: dropping it left the old one alive
       * outside the map and built a second one, with its own filter, order and
       * measured line, beside it under the same name. And what does go is
       * disposed of, or the ceiling would bound a map and nothing else.
       */
      const evict = (): void => {
        for (const [key, shelf] of shelves) {
          if (shelves.size <= keep) return
          if (key === spec.whole) continue
          if (shelf.watched) continue
          shelves.delete(key)
          shelf.dispose()
        }
      }
      const shelfFor = (asked: string): ListView<R> => {
        const standing = shelves.get(asked)
        if (standing !== undefined) {
          // Looked at, so it is not the oldest any more.
          shelves.delete(asked)
          shelves.set(asked, standing)
          return standing
        }
        // A shelf is named by a property, and a property name is a string:
        // asked for the number 1 and asked for the string "1", a screen says
        // the same word, and there is nothing here that could tell them apart.
        // So the rule is the string form of the value — said out loud the one
        // time it matters, which is when a field really does hold both.
        const kinds = new Set<string>()
        const made = list(
          feed,
          asked === spec.whole
            ? spec
            : {
                ...spec,
                where: row => {
                  const held = row[field as unknown as keyof R]
                  if (String(held) !== asked) return false
                  kinds.add(typeof held)
                  if (kinds.size > 1) {
                    notice({
                      kind: 'mixed-shelf',
                      where: `${name}.${asked}`,
                      level: 'warn',
                      message: `shelf "${asked}" of ${name} holds values of ${[...kinds].join(' and ')}: a shelf is named by the text of a value, so these share one`,
                    })
                  }
                  return true
                },
              },
        ).build(`${name}.${asked}`)
        shelves.set(asked, made)
        evict()
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
          set: () => false,
          has: () => true,
          ownKeys: () => [...shelves.keys()],
          getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
        },
      ) as Record<Extract<FieldType<R, F>, string | number> | Whole, ListView<R>>
    },
  }
}
