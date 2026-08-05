// The leaf: a source table, seen as changes.
//
// Nothing is kept here — the table itself is the state. A batch belonging to
// this source passes through; a batch belonging to another is not ours.

import { oracle } from '../node.ts'
import type { SourceNode } from '../node.ts'
import type { Runner } from './runner.ts'

export function sourceRunner(node: SourceNode): Runner {
  return {
    feed: (from, changes) => (node.source === from ? [...changes] : []),
    rebuild: sources => oracle(node, sources),
  }
}
