// The library's front door. React lives behind '#weft/react' so that the graph
// stays usable — and testable — without React in the picture.

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
} from './core/graph.ts'
export type {
  Equal,
  CellOptions,
  InputOptions,
  WatchOptions,
  Readable,
  Watchable,
} from './core/graph.ts'

export { command } from './core/command.ts'
export type { Command, CommandOptions, CommandState, WhileRunning } from './core/command.ts'

export { family } from './core/family.ts'
export type { Family, FamilyOptions } from './core/family.ts'

export { source, fresh } from './core/source.ts'
export type { Source, SourceOptions, Timers } from './core/source.ts'

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
} from './core/remote.ts'
export type { Remote, Held } from './core/remote.ts'

export { keepInput, keepSource, memoryStore, webStore } from './core/keep.ts'
export type { Store, Kept, KeepOptions, Dropped } from './core/keep.ts'

export { outbox } from './core/outbox.ts'
export type { Outbox, OutboxOptions, Entry, EntryState, Handler } from './core/outbox.ts'

export { reconcile } from './core/reconcile.ts'
export type { Reconciliation, ReconcileOptions } from './core/reconcile.ts'

export { serve } from './link/serve.ts'
export type { Surface, ServeOptions } from './link/serve.ts'

export { link, UnknownOutcome } from './link/link.ts'
export type { Link } from './link/link.ts'

export { pairInMemory, channelOverPort } from './link/channels.ts'
export type { Pair, Port } from './link/channels.ts'

export { busHub, channelOverBus } from './link/bus.ts'
export type { Bus, Hub, HubOptions, KeepAliveOptions } from './link/bus.ts'

export { sharedWorkerHub, channelToSharedWorker, sharedWorkersExist } from './link/shared.ts'
export type { SharedScope } from './link/shared.ts'

export { leadOrFollow, webLocks } from './link/lead.ts'
export type { Lock, LeadOptions } from './link/lead.ts'

export { valueOf as seenValue, valueOr, atOnce, perFrame, NOT_YET } from './link/channel.ts'
export type { Channel, Mirrored, Schedule, ToGraph, ToWatcher } from './link/channel.ts'
