// The work of each operation on a single row, shared by the oracle and the
// live path. Two implementations of one operation would drift; one does not.

/** What `pure` does to one row; shared by the oracle and the live path. */

import { evalExpr, truthy } from './expr.ts'
import type { Expr, Row } from './expr.ts'
import type { Key } from '../core/data/key.ts'
import type {
  AggNode,
  ExpandNode,
  FilterNode,
  FoldDecl,
  JoinNode,
  PureNode,
  RowFn,
  ScanNode,
} from './shape.ts'
import { isExpr } from './inner.ts'

export function pureRow(node: PureNode, row: Row): Row {
  let out: Row = row
  if (node.fields !== undefined) {
    out = { ...row }
    for (const [name, e] of Object.entries(node.fields)) {
      out[name] = isExpr(e) ? evalExpr(e, row) : e(row)
    }
  }
  if (node.pick !== undefined) {
    const kept: Row = {}
    for (const name of node.pick) kept[name] = out[name]
    out = kept
  }
  return out
}

export const passesFilter = (node: FilterNode, row: Row): boolean =>
  isExpr(node.test) ? truthy(node.test, row) : node.test(row) === true

/** The equi-key a row stands under, for one side of a join. */
export const onKeyOf = (
  pairs: ReadonlyArray<{ left: string; right: string }>,
  side: 'left' | 'right',
  row: Row,
): string => JSON.stringify(pairs.map(p => row[p[side]] ?? null))

/** The merged row of a pair; the phantom of a keeping row stands with null. */
export const mergedRow = (node: JoinNode, left: Row, right: Row | null): Row => ({
  ...left,
  [node.as]: right,
})

export const passesResidual = (node: JoinNode, merged: Row): boolean =>
  node.residual === undefined
    ? true
    : isExpr(node.residual)
      ? truthy(node.residual, merged)
      : node.residual(merged) === true

export const foldOf = (decl: FoldDecl, row: Row): unknown => {
  if (decl.fold === 'count' || decl.fold === 'custom') return undefined
  if (decl.fold === 'collect' && decl.of === undefined) return undefined
  const of = decl.of as Expr | RowFn
  return isExpr(of) ? evalExpr(of, row) : of(row)
}

/** One fold's answer over one group, recounted — the floor every carrier is
 *  measured against. `collect` and `custom` walk rows by key order, the one
 *  order two implementations can agree on. */
export function foldOne(decl: FoldDecl, rows: ReadonlyMap<Key, Row>): unknown {
  switch (decl.fold) {
    case 'count':
      return rows.size
    case 'sum': {
      let sum = 0
      for (const row of rows.values()) sum += foldOf(decl, row) as number
      return sum
    }
    case 'min':
    case 'max': {
      let best: unknown = null
      for (const row of rows.values()) {
        const v = foldOf(decl, row)
        if (best === null) best = v
        else if (
          decl.fold === 'min' ? (v as number) < (best as number) : (v as number) > (best as number)
        ) {
          best = v
        }
      }
      return best
    }
    case 'collect': {
      const order = decl.by
      const byKey = [...rows.keys()].toSorted((a, b) => {
        if (order !== undefined) {
          const moved = orderCompare(order, rows.get(a) as Row, rows.get(b) as Row)
          if (moved !== 0) return moved
        }
        return String(a) < String(b) ? -1 : 1
      })
      return byKey.map(k => {
        const row = rows.get(k) as Row
        return decl.of === undefined ? row : foldOf(decl, row)
      })
    }
    case 'custom': {
      const byKey = [...rows.keys()].toSorted((a, b) => (String(a) < String(b) ? -1 : 1))
      let acc = decl.zero
      for (const k of byKey) acc = decl.add(acc, rows.get(k) as Row)
      return acc
    }
  }
}

/** One group's whole answer: the by-fields plus every fold. */
export function foldGroup(
  node: AggNode,
  rows: ReadonlyMap<Key, Row>,
  groupValues: readonly unknown[],
): Row {
  const out: Row = {}
  node.by.forEach((f, i) => (out[f] = groupValues[i]))
  for (const [name, decl] of Object.entries(node.folds)) out[name] = foldOne(decl, rows)
  return out
}

/** One parent row unfolded: its other fields plus the nested row under the
 *  alias. A field that is not an array unfolds into nothing. */
export function expandRows(node: ExpandNode, row: Row): Row[] {
  const nested = row[node.field]
  if (!Array.isArray(nested)) return []
  const { [node.field]: _gone, ...rest } = row
  // oxlint-disable-next-line no-map-spread -- each expanded row must be its own object: they land in a table as distinct rows
  return (nested as Row[]).map(inner => ({ ...rest, [node.as]: inner }))
}

/** The values a row files under — the group it belongs to. */
export const groupOf = (node: AggNode, row: Row): unknown[] => node.by.map(f => row[f] ?? null)

/** The comparison a scan's order declares. */
export function orderCompare(
  order: ReadonlyArray<{ field: string; down?: boolean }>,
  a: Row,
  b: Row,
): number {
  for (const { field: f, down } of order) {
    const l = a[f]
    const r = b[f]
    if (l === r) continue
    const less = (l as number) < (r as number)
    return (less ? -1 : 1) * (down === true ? -1 : 1)
  }
  return 0
}

export const stepOf = (node: ScanNode, row: Row): number =>
  (isExpr(node.step) ? evalExpr(node.step, row) : node.step(row)) as number
