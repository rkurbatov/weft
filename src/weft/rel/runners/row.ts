// The two runners that judge or reshape one row at a time, and keep nothing.
//
// A filter lets a change through as far as its two sides pass the test — a row
// that stops passing leaves, one that starts passing arrives, and the pair of
// the two is an ordinary edit. A projection rewrites both sides and passes the
// change along. Neither needs an index, which is why they sit together.

import { passesFilter, pureRow, recount } from '../node.ts'
import type { FilterNode, PureNode } from '../node.ts'
import type { Change } from '../../core/table/table.ts'
import type { Row } from '../expr.ts'
import type { Make, Runner } from './runner.ts'

export function filterRunner(node: FilterNode, make: Make): Runner {
  const input = make(node.input)
  return {
    feed(from, changes) {
      const out: Change<Row>[] = []
      for (const under of input.feed(from, changes)) {
        const prev =
          under.prev !== undefined && passesFilter(node, under.prev) ? under.prev : undefined
        const next =
          under.next !== undefined && passesFilter(node, under.next) ? under.next : undefined
        if (prev === undefined && next === undefined) continue
        out.push({
          key: under.key,
          ...(prev === undefined ? {} : { prev }),
          ...(next === undefined ? {} : { next }),
        })
      }
      return out
    },
    rebuild: sources => recount(node, sources),
  }
}

export function pureRunner(node: PureNode, make: Make): Runner {
  const input = make(node.input)
  return {
    feed(from, changes) {
      const out: Change<Row>[] = []
      for (const under of input.feed(from, changes)) {
        out.push({
          key: under.key,
          ...(under.prev === undefined ? {} : { prev: pureRow(node, under.prev) }),
          ...(under.next === undefined ? {} : { next: pureRow(node, under.next) }),
        })
      }
      return out
    },
    rebuild: sources => recount(node, sources),
  }
}
