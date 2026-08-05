// Building a carrier from a decision. The only place that maps one to the
// other, so a new carrier is a new file plus one line here.

import type { Carrier } from '../plan.ts'
import type { FoldCarrier, FoldWork } from './carrier.ts'
import { runningCarrier } from './running.ts'
import { treeCarrier } from './tree.ts'

export type { FoldCarrier, FoldWork, Rows } from './carrier.ts'
export { runningCarrier } from './running.ts'
export { treeCarrier } from './tree.ts'

export function carrierFor<R, A>(kind: Carrier, work: FoldWork<R, A>): FoldCarrier<R, A> {
  // 'running' and 'recount' are the same carrier told apart by the inverse the
  // work does or does not have — the plan names them separately because the
  // cost differs, not because the code does.
  return kind === 'tree' ? treeCarrier(work) : runningCarrier(work)
}
