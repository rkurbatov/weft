// Disk: the places a value can be kept, and what a cell does with one.
//
// What is kept carries the moment it arrived, so an answer that survives a
// reload is honest about its age instead of pretending to be new.

export { bestStore, idbStore, keepInput, keepSupply, memoryStore, webStore, within } from '#store'
export type { Dropped, IdbOptions, KeepOptions, Kept, Saving, Scope, Store } from '#store'
