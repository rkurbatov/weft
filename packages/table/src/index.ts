// The table package: rows with a key, live views over them, folds and the
// planner that picks how to keep them. Nothing here knows about relational
// trees — that is the layer above; the stream of changes a table produces is
// the feed package's contract, and a consumer that carries a table elsewhere
// takes it from there.

// The planner, for the layer above: the relational layer runs scans and folds
// of its own and asks the same empiricism this table asks — the numbers behind
// the choice were measured once, in one place, and a second copy of them would
// be a second answer. A neighbour on the stack is a rightful reader of a door;
// the front door does not carry these on, because choosing how to keep a fold
// is not an application's question.
export type { Carrier, Plan, ScanPlan, ScanCarrier, ScanForm } from './plan.ts'
export { planFold, planScan } from './plan.ts'
export { table, alike } from './table.ts'
export type { Table, SourceTable, TableOptions, Ordered, FoldSpec, Patch } from './table.ts'

// The feed behind a table, for anything that carries it somewhere else. The
// contract and the following live in `#feed`; this hands out the one a table
// is holding.
export { feedOf } from './feeds.ts'
