// What the two sheets share: the sample sheet, the formula language they
// compute with, the decimal underneath it and cell addresses. Reached as
// '#sheet'.
//
// Here rather than in the demo-wide door because a board, a rail and a table
// have no formulas and no A1 — a shared set that everyone imports and two
// pages use is not a shared set, it is a pile.

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

// The grid itself is markup and lives in ui.tsx, reached as '#sheet/ui.tsx':
// kept out of this door so a bench can import the formulas without React.
