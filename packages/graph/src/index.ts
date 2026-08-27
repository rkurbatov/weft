// The graph package: nodes, engines, regions, commands, families, waves and
// the journal, plus the plain values everything else is built from.

export {
  port,
  derived,
  watch,
  subscribe,
  batch,
  untracked,
  Port,
  Derived,
  Watcher,
  trace,
  graph,
  attachProbe,
} from './graph.ts'
export type {
  Equal,
  DerivedOptions,
  PortOptions,
  WatchOptions,
  Readable,
  Watchable,
  Trace,
  Engine,
} from './graph.ts'
export { command, CommandReset, onCommandFailure } from './command.ts'
export type { Command, CommandOptions, CommandState, WhileRunning } from './command.ts'
export { family } from './family.ts'
export type { Family, FamilyOptions } from './family.ts'

// Of the planner, only what an application has a reason to touch: hearing the
// decisions, and naming a carrier by hand in a passport. Deciding is the
// library's own business, and its traits and plans are not offered.
export { region, owned, regionName } from './region.ts'
export type { Region } from './region.ts'
export { quietly } from './ticks.ts'
export type { Probe, TickSummary, TickWrite, TickCompute } from './ticks.ts'
export type { EngineOptions } from './engine.ts'

// The retention seam, for the caches inside the library and nothing else:
// named here, never at the door in `#weft`.
export { engineOf, facet, keep } from './graph.ts'
export { nameOfKey } from './family.ts'
export type { Keeper } from './parts.ts'
export { giveWay } from './time.ts'
export { wallClock } from '#core'
export type { Timers } from '#core'
// One instrument for the whole question "what is the graph doing": counters and
// the journal share the engine's single probe instead of taking turns at it.
export { gauge } from './gauge.ts'
export type { Gauge, GaugeOptions, Counted, Recorded } from './gauge.ts'
// The notice channel: the graph owns the subject — what the library decided
// and why — so it hands the listening half out. The channel lives in the
// machine room because the layer below the graph speaks on it too.
export { notice, onNotice, forgetNotices } from '#core'
export type { Notice, Level } from '#core'
