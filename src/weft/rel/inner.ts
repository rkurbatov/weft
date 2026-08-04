// Small helpers shared inside the relational layer and nowhere else: reading a
// path out of a row, putting a composite key back together, telling an
// expression from an escape-hatch closure, and substituting into both.

import { paramsOfExpr, substituteExpr } from './expr.ts'
import type { Expr, Row } from './expr.ts'
import type { Key } from '../core/data/key.ts'
import type { FoldDecl, RelNode, RowFn } from './shape.ts'
import { keyPaths } from './keys.ts'

export const readPath = (row: Row, path: readonly string[]): unknown => {
  let at: unknown = row
  for (const step of path) {
    if (at === null || typeof at !== 'object') return null
    at = (at as Row)[step]
  }
  return at ?? null
}

/** A row's key under a node's rule: one path plain, several as a joined form. */
export const recomposeKey = (node: RelNode, values: unknown[]): Key =>
  keyPaths(node).length === 1 ? (values[0] as Key) : JSON.stringify(values)
export const isExpr = (e: Expr | RowFn): e is Expr => typeof e !== 'function'

/** Canon of the tree, or null when a closure stands anywhere inside. */
export const subExpr = <E extends Expr | RowFn>(e: E, values: ReadonlyMap<string, unknown>): E =>
  (isExpr(e) ? substituteExpr(e, values) : e) as E
export const subFold = (decl: FoldDecl, values: ReadonlyMap<string, unknown>): FoldDecl => {
  if (decl.fold === 'count' || decl.fold === 'custom') return decl
  if (decl.of === undefined) return decl
  return { ...decl, of: subExpr(decl.of, values) }
}

/** The same tree with every hole filled — what actually runs; the original,
 *  holes and all, stays the tree's identity. */
export const paramsOfE = (e: Expr | RowFn, out: Set<string>): void => {
  if (isExpr(e)) paramsOfExpr(e, out)
}

/** Every hole under a node, by name. */
