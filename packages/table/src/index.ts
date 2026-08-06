// The table package: rows with a key, live views over them, folds and the
// planner that picks how to keep them, the measured line and the block tree.
// Nothing here knows about relational trees — that is the layer above.

export type { Carrier, Plan, ScanPlan } from './plan.ts'
export { blocks } from './blocks.ts'
export type { Blocks, BlockOptions } from './blocks.ts'
export { offsets } from './offsets.ts'
export type { Offsets } from './offsets.ts'
export { table, alike } from './table.ts'
export type { Table, SourceTable, TableOptions, Ordered, FoldSpec, Patch, Change } from './table.ts'

// The relational layer's own surface: trees as data, the builder over them.
