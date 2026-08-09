// Disk: where a value goes so a reload finds it, and the doors to the places
// it can go.
//
// Two subjects, one because the second is nothing without the first: a store
// is a place with four verbs, and keeping is what a cell does with one. What
// is kept carries the moment it arrived, so an answer that survives a reload
// is honest about its age instead of pretending to be new.

export { memoryStore, pack, unpack, webStore, within } from './store.ts'
export type { Store, Scope } from './store.ts'
export { idbStore, bestStore } from './idb.ts'
export type { IdbOptions } from './idb.ts'
export { keepInput, keepSupply, SAVING } from './keep.ts'
export type { Kept, KeepOptions, Saving, Dropped } from './keep.ts'
