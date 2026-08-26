// The door of a live collection: one the world keeps changing.
//
// Called `live` and not `feed`: a feed is the stream of keyed changes one
// package below, and one word cannot mean both a stream and the collection
// that reads it. What this holds is live state — the dialect's own subject.
//
// A truth is an answer to a question; a feed is not. It arrives once and then
// keeps arriving in pieces — a ticker, an inbox, a board others are editing —
// and it lives between questions. The passport says three things: what a row's
// key is, who wins when two writers bring the same row, and how the feed is
// fed. Everything else is reading.
//
// Feeding starts with the first look and stops when the last one leaves, so a
// list nobody watches costs nothing and holds no socket.

import { table } from '#weft'
import type { Key, Watchable } from '#weft'

export interface Delta<R> {
  put?: readonly R[]
  drop?: readonly Key[]
}

export interface LivePassport<R> {
  name?: string
  key: (row: R) => Key
  /**
   * Who stands when two writers bring the same row: `true` lets the incoming
   * one in. This is how a page that travelled slowly loses to the live event
   * that overtook it. Absent, whatever comes last wins.
   */
  wins?: (next: R, standing: R) => boolean
  /** What counts as the same row. Structural by default. */
  same?: (a: R, b: R) => boolean
  /**
   * The live half. Called on the first look with a hand to feed by; the
   * function it returns is called when the last look goes away.
   */
  live?: (feed: (delta: Delta<R>) => void) => () => void
}

export interface Sorted<R> {
  size: Watchable<number>
  /** Is anybody watching this order — its size, the whole of it, or a window? */
  readonly watched: boolean
  /**
   * Every row, in this order. The honest slow path — a screen showing more
   * than a screenful wants `window` — but a list of twenty with an order and
   * no window has to be able to say what the order was.
   */
  rows: Watchable<readonly R[]>
  /** A range read as a dependency, for building a cell over bounds that move. */
  read: (from: number, to: number) => readonly R[]
  /** A window; it wakes only when the window itself moves. */
  window: (from: number, to: number) => Watchable<readonly R[]>
  /** Where this row stands now, or below zero if it is gone. Plain, not a
   *  formula's business: made for holding a scrolled row in place. */
  place: (key: Key) => number
  dispose: () => void
}

/**
 * The reading half of a feed: what a part of one can offer.
 *
 * A filtered or ordered view is a way of looking at rows somebody else owns.
 * `only()` used to hand back the whole `Live<R>` — writing side and all —
 * because that was the type at hand, so `board.only(mine).take(row)` compiled
 * and then threw at run time. What a view cannot do it now cannot be asked to
 * do.
 */
export interface LiveView<R> {
  readonly name: string
  /** How a row's key is taken. Kept so the query layer can learn the field
   *  names from it instead of being told them a second time. */
  readonly keyOf: (row: R) => Key
  /** Every row, in the order they first arrived. */
  rows: Watchable<readonly R[]>
  size: Watchable<number>
  /** One row's own cell: it wakes when that row moves, and no oftener. */
  row: (key: Key) => Watchable<R | undefined>
  /** A part of the feed, by a test that may itself be a formula. */
  only: (test: (row: R) => boolean, name?: string) => LiveView<R>
  onlyLive: (pick: () => (row: R) => boolean, name?: string) => LiveView<R>
  sortedBy: (compare: (a: R, b: R) => number, name?: string) => Sorted<R>
  count: (test?: (row: R) => boolean) => Watchable<number>
  sumBy: (measure: (row: R) => number) => Watchable<number>
  dispose: () => void
}

/** A feed itself: a view, and the side that puts rows into it. */
export interface Live<R> extends LiveView<R> {
  /** Rows the application fetched itself — a page, a search, a reload. */
  /** Rows in: loose, or one collection. `take(rows)` never spreads. */
  take: (...rows: readonly R[] | [Iterable<R>]) => void
  /** Rows the application knows are gone. */
  lose: (...keys: readonly Key[] | [Iterable<Key>]) => void
  /** A batch from the world, put and drop together. */
  feed: (delta: Delta<R>) => void
  /** The whole picture anew; rows that stayed keep their identity. */
  reset: (rows: Iterable<R>) => void
  peek: (key: Key) => R | undefined
}

type EngineTable<R> = ReturnType<typeof table<R>>

/** The reading side of a feed, shared by the whole feed and by its parts. */
function reading<R>(
  t: EngineTable<R> | ReturnType<EngineTable<R>['where']>,
  keyOf: (row: R) => Key,
): LiveView<R> {
  return {
    name: t.name,
    keyOf,
    rows: t.all,
    size: t.size,
    row: key => t.row(key),
    only: (test, name) => reading(t.where(test, name), keyOf),
    onlyLive: (pick, name) => reading(t.whereLive(pick, name), keyOf),
    sortedBy: (compare, name) => {
      const order = t.orderBy(compare, name)
      return {
        size: order.size,
        rows: order.all,
        read: (from, to) => order.read(from, to),
        window: (from, to) => order.slice(from, to),
        place: key => order.rank(key),
        dispose: () => order.dispose(),
        // The order answers for itself. Nothing here wraps its cells in cells
        // of its own, so an observer of any of them is somebody outside.
        get watched(): boolean {
          return order.watched
        },
      }
    },
    count: test => t.count(test),
    sumBy: measure => t.sumBy(measure),
    dispose: () => t.dispose(),
  }
}

// The engine table behind a feed — for the shape layer, which compiles a
// declared form into a relational tree over this very table. Not part of the
// feed's own surface: applications never need it.
const tables = new WeakMap<object, unknown>()

export function tableOfLive<R>(of: Live<R>): EngineTable<R> {
  const held = tables.get(of as unknown as object)
  if (held === undefined) throw new Error(`loom: ${of.name} has no table behind it`)
  return held as EngineTable<R>
}

export function live<R>(passport: LivePassport<R>): Live<R> {
  const name = passport.name ?? 'feed'
  let stopLive: (() => void) | undefined

  const t = table<R>({
    name,
    key: passport.key,
    ...(passport.wins === undefined ? {} : { wins: passport.wins }),
    ...(passport.same === undefined ? {} : { equal: passport.same }),
    ...(passport.live === undefined
      ? {}
      : {
          onDemand: () => {
            stopLive = passport.live?.(delta => t.apply(delta))
          },
          onIdle: () => stopLive?.(),
        }),
  })

  const self = {
    ...reading(t, passport.key),
    // Passed through as they came: one collection stays one argument, so a
    // large one is never spread into call arguments.
    take: (...rows) => t.put(...rows),
    lose: (...keys) => t.drop(...keys),
    feed: delta => t.apply(delta),
    reset: rows => t.replace(rows),
    peek: key => t.peek(key),
  } as Live<R>
  tables.set(self as unknown as object, t)
  return self
}