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
  graph,
  attachProbe,
} from './core/graph/graph.ts'
export type {
  Equal,
  CellOptions,
  InputOptions,
  WatchOptions,
  Readable,
  Watchable,
  Trace,
  Engine,
} from './core/graph/graph.ts'

export { command, onCommandFailure } from './core/graph/command.ts'
export type { Command, CommandOptions, CommandState, WhileRunning } from './core/graph/command.ts'

export { family } from './core/graph/family.ts'
export type { Family, FamilyOptions } from './core/graph/family.ts'

// Of the planner, only what an application has a reason to touch: hearing the
// decisions, and naming a carrier by hand in a passport. Deciding is the
// library's own business, and its traits and plans are not offered.
export { onPlan, onScanPlan } from './core/table/plan.ts'
export type { Carrier, Plan, ScanPlan } from './core/table/plan.ts'
export { blocks } from './core/table/blocks.ts'
export type { Blocks, BlockOptions } from './core/table/blocks.ts'
export { offsets } from './core/table/offsets.ts'
export type { Offsets } from './core/table/offsets.ts'

export { source, fresh, arrivalOf } from './core/remote/source.ts'
export type { Source, SourceOptions } from './core/remote/source.ts'

export { query } from './core/remote/query.ts'
export type { Query, QueryOptions } from './core/remote/query.ts'

export { region, owned, regionName } from './core/graph/region.ts'
export type { Region } from './core/graph/region.ts'

export { quietly } from './core/graph/waves.ts'
export type { Probe, WaveSummary, WaveWrite, WaveCompute } from './core/graph/waves.ts'
export type { EngineOptions } from './core/graph/engine.ts'
export { journal } from './core/graph/journal.ts'
export type { Journal } from './core/graph/journal.ts'

export { projected } from './core/keep/project.ts'
export { preserve } from './core/data/preserve.ts'
export type { ProjectionSpec } from './core/keep/project.ts'
export { laneDrop, lanePlace, laneAppend, laneFind } from './core/data/arrange.ts'
export type { Lanes } from './core/data/arrange.ts'

export { table, alike } from './core/table/table.ts'
export type {
  Table,
  SourceTable,
  TableOptions,
  Ordered,
  FoldSpec,
  Patch,
  Change,
  Key,
} from './core/table/table.ts'

export { wallClock } from './core/graph/time.ts'
export type { Timers } from './core/graph/time.ts'

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
} from './core/remote/remote.ts'
export type { Remote, Held, Fault } from './core/remote/remote.ts'

export { memoryStore, webStore, within } from './core/keep/store.ts'
export type { Store, Scope } from './core/keep/store.ts'

export { idbStore, bestStore } from './core/keep/idb.ts'
export type { IdbOptions } from './core/keep/idb.ts'

export { keepInput, keepSource } from './core/keep/keep.ts'
export type { Kept, KeepOptions, Saving, Dropped } from './core/keep/keep.ts'

export { outbox } from './core/keep/outbox.ts'
export type { Outbox, OutboxOptions, Entry, EntryState, Handler } from './core/keep/outbox.ts'

export { reconcile } from './core/remote/reconcile.ts'
export type { Reconciliation, ReconcileOptions } from './core/remote/reconcile.ts'

export { serve } from './link/serve.ts'
export type { Surface, ServeOptions } from './link/serve.ts'

export { link, Unknown } from './link/link.ts'
export type { Link, LinkOptions } from './link/link.ts'

export { pairInMemory, portChannel } from './link/ports.ts'
export type { Pair, Port } from './link/ports.ts'

export { busHub, busChannel } from './link/bus.ts'
export type { Hub, HubOptions, KeepAliveOptions } from './link/bus.ts'
export { localBroadcast, openBroadcast, overBus } from './link/transport.ts'
export type { Broadcast, BusLike as Bus } from './link/transport.ts'

export { sharedWorkerHub, sharedWorkerChannel, sharedWorkersExist } from './link/shared.ts'
export type { SharedScope } from './link/shared.ts'

export { leadOrFollow, webLocks } from './link/lead.ts'
export type { Lock, LeadOptions } from './link/lead.ts'

export { atOnce, perFrame } from './link/channel.ts'
export type { Channel, Schedule, ToGraph, ToWatcher } from './link/channel.ts'
