// The library's front door. React lives behind '#react/hooks.ts' so that the
// graph stays usable — and testable — without React in the picture.

export {
  input,
  cell,
  watch,
  subscribe,
  batch,
  untracked,
  Input,
  Cell,
  Watcher,
} from "./core/graph.ts";
export type { Equal, CellOptions, InputOptions, WatchOptions, Readable } from "./core/graph.ts";

export { command } from "./core/command.ts";
export type { Command, CommandOptions, CommandState, WhileRunning } from "./core/command.ts";

export { family } from "./core/family.ts";
export type { Family, FamilyOptions } from "./core/family.ts";

export { source, fresh } from "./core/source.ts";
export type { Source, SourceOptions, Timers } from "./core/source.ts";

export {
  valueOf,
  heldOf,
  ageOf,
  isFresh,
  isLoading,
  isFailed,
  loading,
  arrived,
  refused,
} from "./core/remote.ts";
export type { Remote, Held } from "./core/remote.ts";

export { keepInput, keepSource, memoryStore, webStore } from "./core/keep.ts";
export type { Store, Kept, KeepOptions, Dropped } from "./core/keep.ts";

export { outbox } from "./core/outbox.ts";
export type { Outbox, OutboxOptions, Entry, EntryState, Handler } from "./core/outbox.ts";

export { reconcile } from "./core/reconcile.ts";
export type { Reconciliation, ReconcileOptions } from "./core/reconcile.ts";
