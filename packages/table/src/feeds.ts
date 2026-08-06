// Which feed stands behind a table.
//
// A view built over a table needs the feed under it, and the table hands out
// no such thing: the register here is how the two sides of the package find
// each other without the surface growing a hole for it.

import type { Feed, Table } from './shape.ts'

const feeds = new WeakMap<Table<unknown>, Feed<unknown>>()

/** Remember which feed a table was built over. */
export function remember<R>(t: Table<R>, feed: Feed<R>): void {
  feeds.set(t as Table<unknown>, feed as Feed<unknown>)
}

export function feedOf<R>(t: Table<R>): Feed<R> {
  const feed = feeds.get(t as Table<unknown>)
  if (feed === undefined) throw new Error(`weft: ${t.name} has no feed — not an engine table`)
  return feed as Feed<R>
}
