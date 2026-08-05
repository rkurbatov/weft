// Why this row is here: walk the tree down at the moment of asking, rather
// than carrying a pedigree on every row. The answer names the source rows it
// came from — moments in time are the journal's business, not this one's.

/** Why this row: the source rows it came from, found by descent, stored
 *  nowhere. A join splits its composite key back into its parents'; a keeping
 *  phantom, whose right half is all null, names only its left parent. */

import type { Key } from '#graph/data/key.ts'
import type { Row } from './expr.ts'
import type { RelNode } from './shape.ts'
import { keyPaths } from './keys.ts'
import { oracle } from './oracle.ts'
import { groupOf } from './work.ts'
import { recomposeKey } from './inner.ts'

export function whyRow(
  node: RelNode,
  key: Key,
  sources: Record<string, ReadonlyMap<Key, Row>>,
): Array<{ source: string; key: Key }> {
  switch (node.prim) {
    case 'source':
      return [{ source: node.source, key }]
    case 'filter':
    case 'pure':
    case 'scan':
      return whyRow(node.input, key, sources)
    case 'join': {
      const values = JSON.parse(key as string) as unknown[]
      const split = keyPaths(node.left).length
      const leftWhy = whyRow(node.left, recomposeKey(node.left, values.slice(0, split)), sources)
      const rightValues = values.slice(split)
      if (node.keeping === true && rightValues.every(v => v === null)) return leftWhy
      return [...leftWhy, ...whyRow(node.right, recomposeKey(node.right, rightValues), sources)]
    }
    case 'union':
      return oracle(node.left, sources).has(key)
        ? whyRow(node.left, key, sources)
        : whyRow(node.right, key, sources)
    case 'expand': {
      // The nested rows are not source rows of their own: the whole expanded
      // row came from its parent, so the parent's provenance is the answer.
      const values = JSON.parse(key as string) as unknown[]
      const split = keyPaths(node.input).length
      return whyRow(node.input, recomposeKey(node.input, values.slice(0, split)), sources)
    }
    case 'agg': {
      // A group names its members; the members are found when asked, kept
      // nowhere: the input is recounted and sifted by the group's values.
      const wanted =
        node.by.length === 1 ? JSON.stringify([key]) : node.by.length === 0 ? '[]' : (key as string)
      const out: Array<{ source: string; key: Key }> = []
      for (const [underKey, row] of oracle(node.input, sources)) {
        if (JSON.stringify(groupOf(node, row)) !== wanted) continue
        out.push(...whyRow(node.input, underKey, sources))
      }
      return out
    }
  }
}
