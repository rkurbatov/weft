// A nested list unfolded into rows of its own.
//
// Stateless: a parent row alone says what it unfolds into, so a change is the
// difference between its two unfoldings, taken by the key of the unfolded row.
// Two nested rows under one parent that give the same key would be one row
// claiming to be two — named, not resolved.

import { diffInto } from './runner.ts'
import { expandRows, keyOfRow, oracle } from '../node.ts'
import type { ExpandNode } from '../node.ts'
import type { Change, Key } from '#table/table.ts'
import type { Row } from '../expr.ts'
import type { Make, Runner } from './runner.ts'

export function expandRunner(node: ExpandNode, make: Make): Runner {
  const input = make(node.input)

  const opened = (row: Row | undefined): Map<Key, Row> => {
    const out = new Map<Key, Row>()
    if (row === undefined) return out
    for (const one of expandRows(node, row)) {
      const key = keyOfRow(node, one)
      if (out.has(key)) {
        throw new Error(
          `weft rel: expand key collision on ${String(key)} — nested rows must differ`,
        )
      }
      out.set(key, one)
    }
    return out
  }

  return {
    feed(from, changes) {
      const out = new Map<Key, Change<Row>>()
      for (const change of input.feed(from, changes)) {
        diffInto(out, opened(change.prev), opened(change.next))
      }
      return [...out.values()].filter(c => c.prev !== undefined || c.next !== undefined)
    },
    rebuild: sources => oracle(node, sources),
  }
}
