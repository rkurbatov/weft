// Identity of a derived row.
//
// Keys are declared on the source and inherited by rule, so the key of any row
// is recomputed from its content — no hidden identity travels with a row.

/** The paths a node's key is made of — inherited until a primitive says
 *  otherwise; a join's key is both parents' keys, the right side under its
 *  alias. Paths, not names, because a merged row nests. */

import type { Key } from '#graph/data/key.ts'
import type { Row } from './expr.ts'
import type { RelNode } from './shape.ts'
import { readPath } from './inner.ts'

export function keyPaths(node: RelNode): ReadonlyArray<readonly string[]> {
  switch (node.prim) {
    case 'source':
      return node.key.map(f => [f])
    case 'pure':
    case 'filter':
    case 'scan':
      return keyPaths(node.input)
    case 'join':
      return [...keyPaths(node.left), ...keyPaths(node.right).map(p => [node.as].concat(p))]
    case 'agg':
      return node.by.map(f => [f])
    case 'union':
      return keyPaths(node.left)
    case 'expand':
      return [...keyPaths(node.input), ...node.key.map(k => [node.as, k])]
  }
}

/** A row's key under a node's rule: one path plain, several as a joined form. */
export function keyOfRow(node: RelNode, row: Row): Key {
  const paths = keyPaths(node)
  if (paths.length === 1) return readPath(row, paths[0] as readonly string[]) as Key
  // Zero paths is the whole-table fold: one row, one constant key.
  return JSON.stringify(paths.map(p => readPath(row, p)))
}
