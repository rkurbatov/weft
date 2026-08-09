// The oracle: the whole answer computed from scratch. Slow on purpose and
// simple on purpose — the live path is checked against it, step by step, and
// a resync after falling behind falls back to it.

/** The oracle: the whole answer, recounted from the sources. */

import type { Key } from '#feed'
import type { Row } from './expr.ts'
import type { RelNode } from './contract.ts'
import { keyOfRow } from './keys.ts'
import {
  expandRows,
  foldGroup,
  groupOf,
  mergedRow,
  onKeyOf,
  orderCompare,
  passesFilter,
  passesResidual,
  pureRow,
  stepOf,
} from './work.ts'

export function oracle(
  node: RelNode,
  sources: Record<string, ReadonlyMap<Key, Row>>,
): Map<Key, Row> {
  switch (node.prim) {
    case 'source': {
      const held = sources[node.source]
      if (held === undefined) throw new Error(`weft rel: unknown source '${node.source}'`)
      return new Map(held)
    }
    case 'filter': {
      const out = new Map<Key, Row>()
      for (const [key, row] of oracle(node.input, sources)) {
        if (passesFilter(node, row)) out.set(key, row)
      }
      return out
    }
    case 'pure': {
      const out = new Map<Key, Row>()
      for (const [key, row] of oracle(node.input, sources)) out.set(key, pureRow(node, row))
      return out
    }
    case 'agg': {
      const under = oracle(node.input, sources)
      const groups = new Map<Key, { values: unknown[]; rows: Map<Key, Row> }>()
      for (const [key, row] of under) {
        const values = groupOf(node, row)
        const at = JSON.stringify(values)
        let held = groups.get(at)
        if (held === undefined) {
          held = { values, rows: new Map() }
          groups.set(at, held)
        }
        held.rows.set(key, row)
      }
      const out = new Map<Key, Row>()
      for (const { values, rows } of groups.values()) {
        const row = foldGroup(node, rows, values)
        out.set(keyOfRow(node, row), row)
      }
      // The whole-table fold exists even over nothing.
      if (node.by.length === 0 && out.size === 0) {
        const empty = foldGroup(node, new Map(), [])
        out.set(keyOfRow(node, empty), empty)
      }
      return out
    }
    case 'scan': {
      const under = [...oracle(node.input, sources)]
      // Ties are broken by key, so two implementations agree on the order.
      under.sort(
        ([ka, a], [kb, b]) => orderCompare(node.order, a, b) || (String(ka) < String(kb) ? -1 : 1),
      )
      const out = new Map<Key, Row>()
      let carry = node.from ?? 0
      for (const [key, row] of under) {
        const before = carry
        carry += stepOf(node, row)
        if (node.as === undefined && node.through === undefined) {
          out.set(key, row)
          continue
        }
        const marked: Row = { ...row }
        if (node.as !== undefined) marked[node.as] = before
        if (node.through !== undefined) marked[node.through] = carry
        out.set(key, marked)
      }
      return out
    }
    case 'union': {
      const out = oracle(node.left, sources)
      for (const [key, row] of oracle(node.right, sources)) {
        if (out.has(key)) {
          throw new Error(
            `weft rel: union key collision on ${String(key)} — sides must be disjoint`,
          )
        }
        out.set(key, row)
      }
      return out
    }
    case 'expand': {
      const out = new Map<Key, Row>()
      for (const row of oracle(node.input, sources).values()) {
        for (const opened of expandRows(node, row)) {
          const key = keyOfRow(node, opened)
          if (out.has(key)) {
            throw new Error(
              `weft rel: expand key collision on ${String(key)} — nested rows must differ`,
            )
          }
          out.set(key, opened)
        }
      }
      return out
    }
    case 'join': {
      const left = oracle(node.left, sources)
      const right = oracle(node.right, sources)
      const rightByOn = new Map<string | number, Row[]>()
      for (const row of right.values()) {
        const at = onKeyOf(node.on, 'right', row)
        // Nothing in a key field: this row is nobody's partner.
        if (at === undefined) continue
        const held = rightByOn.get(at)
        if (held === undefined) rightByOn.set(at, [row])
        else held.push(row)
      }
      const out = new Map<Key, Row>()
      for (const leftRow of left.values()) {
        let matched = 0
        const at = onKeyOf(node.on, 'left', leftRow)
        for (const rightRow of (at === undefined ? undefined : rightByOn.get(at)) ?? []) {
          const pair = mergedRow(node, leftRow, rightRow)
          if (!passesResidual(node, pair)) continue
          matched++
          out.set(keyOfRow(node, pair), pair)
        }
        if (matched === 0 && node.keeping === true) {
          const alone = mergedRow(node, leftRow, null)
          out.set(keyOfRow(node, alone), alone)
        }
      }
      return out
    }
  }
}
