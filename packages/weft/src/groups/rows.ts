// Rows with a key: a collection fed by deltas, and the live views over it.
//
// The feed behind a table — the stream of changes it produces — comes with it,
// because anything carrying a table somewhere else needs both.

export { alike, table } from '#table'
export type { FoldSpec, Ordered, Patch, SourceTable, Table, TableOptions } from '#table'
export type { Change, Feed, Key } from '#feed'
