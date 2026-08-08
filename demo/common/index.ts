// What every stand shares, whatever it is a stand of: the render counters and
// the ticks instrument.
//
// A door of its own, reached as '#demo', because a shared set fetched by four
// dots of relative path is the first thing that breaks when a stand moves —
// and because a set with a door has to decide what belongs in it. What only
// one family needs lives with that family: the sheet's grid and formulas
// behind '#sheet', the board's server and cards behind '#kanban'.

export {
  countCellRender,
  countGridRender,
  resetCounters,
  timeEdit,
  useCounters,
  useRenderCount,
} from './stats.ts'
export type { Counters } from './stats.ts'
export { TicksPanel } from './ticks.ts'
export type { Inspectable } from './ticks.ts'

// Markup lives in a .tsx and is reached from one: kept out of this door so a
// plain script can import the rest without pulling React in.
