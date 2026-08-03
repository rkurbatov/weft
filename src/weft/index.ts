// The engine's front door — the only way across the unit's boundary. React
// does not exist here: native hooks live in '#weft-react', the convenient
// layer in '#loom'.

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
  trace,
} from './core/graph.ts'
export type {
  Equal,
  CellOptions,
  InputOptions,
  WatchOptions,
  Readable,
  Watchable,
  Trace,
} from './core/graph.ts'

export { command } from './core/command.ts'
export type { Command, CommandOptions, CommandState, WhileRunning } from './core/command.ts'

export { family } from './core/family.ts'
export type { Family, FamilyOptions } from './core/family.ts'

export { blocks } from './core/blocks.ts'
export type { Blocks, BlockOptions } from './core/blocks.ts'

export { source, fresh, arrivalOf } from './core/source.ts'
export type { Source, SourceOptions } from './core/source.ts'

export { query } from './core/query.ts'
export type { Query, QueryOptions } from './core/query.ts'

export { region, owned, regionName } from './core/region.ts'
export type { Region } from './core/region.ts'

export { attachProbe, quietly } from './core/waves.ts'
export type { Probe, WaveSummary, WaveWrite, WaveCompute } from './core/waves.ts'
export { journal } from './core/journal.ts'
export type { Journal } from './core/journal.ts'

export { projected, preserve } from './core/project.ts'
export type { ProjectionSpec } from './core/project.ts'
export { laneDrop, lanePlace, laneAppend, laneFind } from './core/arrange.ts'
export type { Lanes } from './core/arrange.ts'

export { table, alike } from './core/table.ts'
export type {
  Table,
  SourceTable,
  TableOptions,
  Ordered,
  FoldSpec,
  Patch,
  Change,
  Key,
} from './core/table.ts'

export { wallClock } from './core/time.ts'
export type { Timers } from './core/time.ts'

export {
  EMPTY,
  heldOf,
  ageOf,
  isFresh,
  loading,
  arrived,
  refused,
  together,
  firstOf,
} from './core/remote.ts'
export type { Remote, Held, Fault } from './core/remote.ts'

export { memoryStore, webStore } from './core/store.ts'
export type { Store } from './core/store.ts'

export { idbStore, bestStore } from './core/idb.ts'
export type { IdbOptions } from './core/idb.ts'

export { keepInput, keepSource } from './core/keep.ts'
export type { Kept, KeepOptions, Saving, Dropped } from './core/keep.ts'

export { outbox } from './core/outbox.ts'
export type { Outbox, OutboxOptions, Entry, EntryState, Handler } from './core/outbox.ts'

export { reconcile } from './core/reconcile.ts'
export type { Reconciliation, ReconcileOptions } from './core/reconcile.ts'

export { serve } from './link/serve.ts'
export type { Surface, ServeOptions } from './link/serve.ts'

export { link, Unknown } from './link/link.ts'
export type { Link, LinkOptions } from './link/link.ts'

export { pairInMemory, channelOverPort } from './link/ports.ts'
export type { Pair, Port } from './link/ports.ts'

export { busHub, channelOverBus } from './link/bus.ts'
export type { Bus, Hub, HubOptions, KeepAliveOptions } from './link/bus.ts'

export { sharedWorkerHub, channelToSharedWorker, sharedWorkersExist } from './link/shared.ts'
export type { SharedScope } from './link/shared.ts'

export { leadOrFollow, webLocks } from './link/lead.ts'
export type { Lock, LeadOptions } from './link/lead.ts'

export { atOnce, perFrame } from './link/channel.ts'
export type { Channel, Schedule, ToGraph, ToWatcher } from './link/channel.ts'
