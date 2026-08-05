// Which runner runs which operation.
//
// The whole mapping, in one place and in one line each. A new operation is a
// new file beside these and one line here; the orchestrator in live.ts does
// not learn its name, and neither does anything else.

import { aggRunner } from './agg.ts'
import { expandRunner } from './expand.ts'
import { joinRunner } from './join.ts'
import { filterRunner, pureRunner } from './row.ts'
import { scanRunner } from './scan.ts'
import { sourceRunner } from './source.ts'
import { unionRunner } from './union.ts'
import type { Runner } from './runner.ts'
import type { RelNode } from '../node.ts'

export type { Make, Ordering, Runner, Sources } from './runner.ts'
export { diffInto } from './runner.ts'

/** Build the runner of a node, and of everything under it. */
export function runnerFor(node: RelNode): Runner {
  switch (node.prim) {
    case 'source':
      return sourceRunner(node)
    case 'filter':
      return filterRunner(node, runnerFor)
    case 'pure':
      return pureRunner(node, runnerFor)
    case 'join':
      return joinRunner(node, runnerFor)
    case 'agg':
      return aggRunner(node, runnerFor)
    case 'scan':
      return scanRunner(node, runnerFor)
    case 'union':
      return unionRunner(node, runnerFor)
    case 'expand':
      return expandRunner(node, runnerFor)
  }
}
