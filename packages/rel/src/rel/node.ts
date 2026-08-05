// The relational tree: a derived collection as data, not as a closure.
//
// A node is a plain value — primitive, attributes, inputs — following the
// thirteen-primitive table of the language corpus (Warp 10-IR); this file
// carries the ones implemented so far and grows one primitive at a time.
// Expressions inside attributes are data too (expr.ts), so a whole tree
// serialises, hashes and runs against another implementation. A closure may
// stand in for any expression as an escape hatch, and the tree then honestly
// loses its canon: no hash, no place in the cross-implementation corpus.
//
// Keys are declared, not guessed: a source names the fields its key is made
// of, and every derivation's key follows by rule — filter and pure inherit.
// That is what lets a derived row be found, moved and explained by key, and
// a `pure` that picks away a key field is a build error, not a surprise.
//
// The naive oracle here is the oracle: the slowest correct answer, the
// floor every faster path is measured against — and the resync path when a
// follower falls too far behind.

// Named one by one on purpose. `export *` hides a collision until the day two
// modules happen to export the same word — and then it fails somewhere far
// from the cause, in whoever imported the door.

export { agg, expand, filter, join, pure, scan, source, union } from './shape.ts'
export type {
  AggNode,
  ExpandNode,
  FilterNode,
  FoldDecl,
  JoinNode,
  PureNode,
  RelNode,
  RowFn,
  ScanNode,
  SourceNode,
  UnionNode,
} from './shape.ts'

export { keyOfRow, keyPaths } from './keys.ts'
export { canonNode } from './canon.ts'
export { checkNode } from './check.ts'

export {
  expandRows,
  foldGroup,
  foldOf,
  foldOne,
  groupOf,
  mergedRow,
  onKeyOf,
  orderCompare,
  passesFilter,
  passesResidual,
  pureRow,
  stepOf,
} from './work.ts'

export { oracle } from './oracle.ts'
export { paramsOfNode, substituteNode } from './params.ts'
export { whyRow } from './why.ts'
