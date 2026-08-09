// The reading surface a feed wears when it is handed out as a table.
//
// Its own file because both the table itself and every view built over one
// need it, and a shared piece kept inside one of them would make a circle.

import { derived, family } from '#graph'
import type { Key } from '#feed'
import { remember } from './feeds.ts'
import { foldOver } from './fold.ts'
import { orderedOver, whereOver } from './views.ts'
import { sameItems } from './same.ts'
import type { Feed, Table } from './shape.ts'

export function tableOver<R>(feed: Feed<R>, dispose: () => void): Table<R> {
  const rows = family<Key, R | undefined>(
    key => {
      feed.version.get()
      return feed.get(key)
    },
    { name: `${feed.name}.row` },
  )

  const size = derived(
    () => {
      feed.version.get()
      return feed.count()
    },
    { name: `${feed.name}.size` },
  )

  const all = derived(
    () => {
      feed.version.get()
      const out: R[] = []
      feed.each(row => out.push(row))
      return out as readonly R[]
    },
    { name: `${feed.name}.all`, equal: sameItems },
  )

  const self: Table<R> = {
    name: feed.name,
    size,
    all,
    row: key => rows(key),
    where: (test, name) => whereOver(feed, () => test, name ?? `${feed.name}.where`),
    whereLive: (pick, name) => whereOver(feed, pick, name ?? `${feed.name}.where`),
    orderBy: (compare, name) => orderedOver(feed, compare, name ?? `${feed.name}.order`),
    fold: (spec, name) => foldOver(feed, spec, name ?? `${feed.name}.fold`),
    count: test =>
      test === undefined
        ? size
        : foldOver(
            feed,
            {
              zero: 0,
              add: (acc, row) => acc + (test(row) ? 1 : 0),
              sub: (acc, row) => acc - (test(row) ? 1 : 0),
            },
            `${feed.name}.count`,
          ),
    sumBy: measure =>
      foldOver(
        feed,
        {
          zero: 0,
          add: (acc, row) => acc + measure(row),
          sub: (acc, row) => acc - measure(row),
        },
        `${feed.name}.sum`,
      ),
    dispose,
  }
  remember(self, feed)
  return self
}
