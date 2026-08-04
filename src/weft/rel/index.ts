// The relational layer's front door. Deliberately a door of its own, beside
// '#weft' rather than inside it: the engine's main surface does not grow,
// and the layer's names (source, join) collide with nothing.
//
// What it opens: the typed builder as the working surface; trees as data —
// constructors, the checks, the canon and the naive recount, because a tree
// is a value the corpus freezes and another implementation runs; and the
// expression language the attributes are written in.

export { from, Rel } from './builder.ts'
export type { RelationOf, Folds, Fold } from './builder.ts'

export { relate } from './live.ts'
export type { Relation, RelateOptions } from './live.ts'

export {
  source,
  pure,
  filter,
  join,
  agg,
  union,
  expand,
  checkNode,
  canonNode,
  recount,
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
  FoldDecl,
  RowFn,
} from './node.ts'

export { field, lit, param, cmp, and, or, not, math, some, evalExpr, canonExpr } from './expr.ts'
export type { Expr, Row } from './expr.ts'
