// State: cells, what is written into them, and what follows from them.
//
// A value somebody writes, a formula nobody writes, a command that runs once,
// a family of cells by key, a region that owns their life — and the gauge that
// says what the graph did with all of it.

export {
  batch,
  command,
  CommandReset,
  derived,
  family,
  gauge,
  giveWay,
  onCommandFailure,
  port,
  region,
  subscribe,
  trace,
  untracked,
  watch,
} from '#graph'
export type {
  Command,
  CommandOptions,
  CommandState,
  Counted,
  Derived,
  DerivedOptions,
  Equal,
  Family,
  FamilyOptions,
  Gauge,
  GaugeOptions,
  Port,
  PortOptions,
  Readable,
  Recorded,
  Region,
  TickSummary,
  Trace,
  WatchOptions,
  Watchable,
  WhileRunning,
} from '#graph'

// What the library decided on its own — which carrier a fold got, a collection
// too large to keep piece by piece. The graph owns the subject; the channel
// itself lives lower.
// Only the listening half: announcing a decision is what the layers do, and
// an application is on the other end of it.
export { forgetNotices, onNotice } from '#graph'
export type { Level, Notice } from '#graph'
