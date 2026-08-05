// The door of a feed: a collection the world keeps changing.
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

export interface FeedPassport<R> {
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
  /** A window; it wakes only when the window itself moves. */
  window: (from: number, to: number) => Watchable<readonly R[]>
  /** Where this row stands now, or below zero if it is gone. Plain, not a
   *  formula's business: made for holding a scrolled row in place. */
  place: (key: Key) => number
  dispose: () => void
}

export interface Feed<R> {
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
  only: (test: (row: R) => boolean, name?: string) => Feed<R>
  onlyLive: (pick: () => (row: R) => boolean, name?: string) => Feed<R>
  sortedBy: (compare: (a: R, b: R) => number, name?: string) => Sorted<R>
  count: (test?: (row: R) => boolean) => Watchable<number>
  sumBy: (measure: (row: R) => number) => Watchable<number>
  /** Rows the application fetched itself — a page, a search, a reload. */
  take: (...rows: R[]) => void
  /** Rows the application knows are gone. */
  lose: (...keys: Key[]) => void
  /** A batch from the world, put and drop together. */
  feed: (delta: Delta<R>) => void
  /** The whole picture anew; rows that stayed keep their identity. */
  reset: (rows: Iterable<R>) => void
  peek: (key: Key) => R | undefined
  dispose: () => void
}

type EngineTable<R> = ReturnType<typeof table<R>>

/** The reading side of a feed, shared by the whole feed and by its parts. */
function reading<R>(
  t: EngineTable<R> | ReturnType<EngineTable<R>['where']>,
  keyOf: (row: R) => Key,
): Omit<Feed<R>, 'take' | 'lose' | 'feed' | 'reset' | 'peek'> {
  return {
    name: t.name,
    keyOf,
    rows: t.all,
    size: t.size,
    row: key => t.row(key),
    only: (test, name) => reading(t.where(test, name), keyOf) as Feed<R>,
    onlyLive: (pick, name) => reading(t.whereLive(pick, name), keyOf) as Feed<R>,
    sortedBy: (compare, name) => {
      const order = t.orderBy(compare, name)
      return {
        size: order.size,
        window: (from, to) => order.slice(from, to),
        place: key => order.rank(key),
        dispose: () => order.dispose(),
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

export function tableOfFeed<R>(of: Feed<R>): EngineTable<R> {
  const held = tables.get(of as unknown as object)
  if (held === undefined) throw new Error(`loom: ${of.name} has no table behind it`)
  return held as EngineTable<R>
}

export function feed<R>(passport: FeedPassport<R>): Feed<R> {
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
    take: (...rows) => t.put(...rows),
    lose: (...keys) => t.drop(...keys),
    feed: delta => t.apply(delta),
    reset: rows => t.replace(rows),
    peek: key => t.peek(key),
  } as Feed<R>
  tables.set(self as unknown as object, t)
  return self
}
