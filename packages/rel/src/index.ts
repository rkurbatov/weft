// The relational layer's front door. Deliberately a door of its own, beside
// '#weft' rather than inside it: the engine's main surface does not grow,
// and the layer's names (source, join) collide with nothing.
//
// What it opens: the typed builder as the working surface; trees as data —
// constructors, the checks, the canon and the naive oracle, because a tree
// is a value the corpus freezes and another implementation runs; and the
// expression language the attributes are written in.

export { from, Rel } from './builder.ts'
export type { Fold, Folds, RelationOf } from './builder.ts'

export { relate } from './live.ts'
export type { Relation, RelateOptions, Ordering } from './live.ts'

export {
  source,
  pure,
  filter,
  join,
  agg,
  union,
  expand,
  scan,
  checkNode,
  canonNode,
  oracle,
  keyOfRow,
  keyPaths,
  whyRow,
  substituteNode,
  paramsOfNode,
} from './node.ts'
export type {
  RelNode,
  SourceNode,
  PureNode,
  FilterNode,
  JoinNode,
  AggNode,
  UnionNode,
  ExpandNode,
  ScanNode,
  FoldDecl,
  RowFn,
} from './node.ts'

export { field, lit, param, cmp, and, or, not, math, some, evalExpr, canonExpr } from './expr.ts'
export type { Expr, Row } from './expr.ts'
// The field types: which fields may be compared, ordered or added up. The
// dialect passes them through rather than declaring a second copy.
export type { Scalar, ScalarField, NumericField, FieldType } from './guards.ts'
// And the complaints themselves: a layer above states a field name loosely and
// judges it with these, so the compiler names what is wrong instead of listing
// every field that would have been legal.
export type {
  MustBeAField,
  MustBeComparable,
  MustBeFree,
  MustBeNumber,
  MustHoldRows,
  MustMatch,
} from './guards.ts'
