// The table package: rows with a key, live views over them, folds and the
// planner that picks how to keep them, the measured line and the block tree.
// Nothing here knows about relational trees — that is the layer above.

export type { Carrier, Plan, ScanPlan } from './plan.ts'
export { table, alike } from './table.ts'
export type { Table, SourceTable, TableOptions, Ordered, FoldSpec, Patch, Change } from './table.ts'

// The relational layer's own surface: trees as data, the builder over them.

// For anything that carries a table somewhere else: the feed behind it, and the
// way to follow one. Not for applications — a screen reads the table itself.
export { feedOf } from './feeds.ts'
export { follow } from './log.ts'
export type { Feed, Follower } from './shape.ts'
