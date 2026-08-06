// The offline package: the disk, kept values, the outbox and the projection of
// unsent notes over what the server said.

export { projected } from './project.ts'
export type { ProjectionSpec } from './project.ts'
export { memoryStore, webStore, within } from './store.ts'
export type { Store, Scope } from './store.ts'
export { idbStore, bestStore } from './idb.ts'
export type { IdbOptions } from './idb.ts'
export { keepInput, keepSource } from './keep.ts'
export type { Kept, KeepOptions, Saving, Dropped } from './keep.ts'
export { outbox } from './outbox.ts'
export type { Outbox, OutboxOptions, Note, NoteState, Handler } from './outbox.ts'
