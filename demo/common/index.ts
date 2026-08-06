// What every example shares: the instrument panel, the sample sheet, the
// formula language they compute with, the decimal, addresses and counters.
//
// A door of its own, reached as '#demo', because a shared set fetched by four
// dots of relative path is the first thing that breaks when an example moves —
// and because a set with a door has to decide what belongs in it.

export { columnName, columnNumber, parseRef, refName, spanRefs } from './address.ts'
export type { Ref } from './address.ts'
export {
  PLACES,
  ZERO,
  abs,
  add,
  cmp,
  div,
  fromFloat,
  fromInt,
  fromText,
  isSafe,
  mul,
  neg,
  rem,
  round,
  sign,
  sub,
  toFloat,
  toText,
  trunc,
} from './dec.ts'
export type { Dec } from './dec.ts'
export {
  asDec,
  counts,
  evaluate,
  fail,
  foldJoin,
  foldOne,
  foldZero,
  isError,
  parse,
  plan,
  read,
  run,
  same,
  show,
} from './formula.ts'
export type { CellError, ErrorCode, FoldName, Lookup, Node, Plan, Value } from './formula.ts'
export { BLOCK, SHEET, key, sampleSheet, shapeFromLocation, sizeOf } from './sample.ts'
export type { Contents, SheetShape } from './sample.ts'
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
