// The front door: everything the library offers the world, in one import.
//
// Named one by one on purpose. `export *` from six packages hides a collision
// until two of them happen to use the same word — and then it is resolved by
// the order of the lines, which is to say by accident. It happened here once
// already: the relational layer's node constructor and the live source are
// both called `source`.
//
// Behind this door the units are separate packages already — data, graph,
// table, remote, keep, link — and anyone who wants only a part takes that part
// directly. React does not exist here: hooks live in '#react', the dialect in
// '#loom'.

export {
  PRESERVE_LIMIT,
  forgetNotices,
  laneAppend,
  laneDrop,
  laneFind,
  lanePlace,
  notice,
  onNotice,
  preserve,
} from '#data'

export type { Key, Lanes, Level, Notice } from '#data'

export {
  Derived,
  Port,
  Watcher,
  attachProbe,
  batch,
  command,
  derived,
  family,
  giveWay,
  graph,
  journal,
  onCommandFailure,
  owned,
  port,
  quietly,
  region,
  regionName,
  subscribe,
  trace,
  untracked,
  wallClock,
  watch,
} from '#graph'

export type {
  Command,
  CommandOptions,
  CommandState,
  DerivedOptions,
  Engine,
  EngineOptions,
  Equal,
  Family,
  FamilyOptions,
  Journal,
  PortOptions,
  Probe,
  Readable,
  Region,
  TickCompute,
  TickSummary,
  TickWrite,
  Timers,
  Trace,
  WatchOptions,
  Watchable,
  WhileRunning,
} from '#graph'

export { alike, blocks, offsets, table } from '#table'

export type {
  BlockOptions,
  Blocks,
  Carrier,
  Change,
  FoldSpec,
  Offsets,
  Ordered,
  Patch,
  Plan,
  ScanPlan,
  SourceTable,
  Table,
  TableOptions,
} from '#table'

export {
  EMPTY,
  ageOf,
  arrivalOf,
  arrived,
  firstOf,
  fresh,
  heldOf,
  isFresh,
  loading,
  query,
  reconcile,
  refused,
  source,
  together,
} from '#remote'

export type {
  Fault,
  Held,
  Query,
  QueryOptions,
  ReconcileOptions,
  Reconciliation,
  Remote,
  Source,
  SourceOptions,
  Tally,
} from '#remote'

export {
  bestStore,
  idbStore,
  keepInput,
  keepSource,
  memoryStore,
  outbox,
  projected,
  webStore,
  within,
} from '#keep'

export type {
  Dropped,
  Handler,
  IdbOptions,
  KeepOptions,
  Kept,
  Note,
  NoteState,
  Outbox,
  OutboxOptions,
  ProjectionSpec,
  Saving,
  Scope,
  Store,
} from '#keep'

export {
  Unknown,
  atOnce,
  busChannel,
  busHub,
  every,
  hurried,
  leadOrFollow,
  link,
  localBroadcast,
  openBroadcast,
  overBus,
  overWire,
  perFrame,
  serve,
  sharedWorkerChannel,
  sharedWorkerHub,
  sharedWorkersExist,
  webLocks,
  wirePair,
} from '#link'

export type {
  Broadcast,
  BusLike,
  Channel,
  Hub,
  HubOptions,
  Hurried,
  KeepAliveOptions,
  LeadOptions,
  Link,
  LinkOptions,
  Lock,
  Mirrored,
  Schedule,
  ServeOptions,
  SharedScope,
  Surface,
  ToGraph,
  ToWatcher,
  Wire,
  WirePair,
} from '#link'

// The relational layer keeps its own door at '#rel': its words — source, join,
// filter — belong to the tree being built, not to the application, and one of
// them would collide with the live source above.
