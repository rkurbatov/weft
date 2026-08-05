// The rel package: tables and their views, folds and the planner that picks how
// to keep them, and the relational layer over it — operations as data.

export type { Carrier, Plan, ScanPlan } from './table/plan.ts'
export { blocks } from './table/blocks.ts'
export type { Blocks, BlockOptions } from './table/blocks.ts'
export { offsets } from './table/offsets.ts'
export type { Offsets } from './table/offsets.ts'
export { table, alike } from './table/table.ts'
export type {
  Table,
  SourceTable,
  TableOptions,
  Ordered,
  FoldSpec,
  Patch,
  Change,
  Key,
} from './table/table.ts'

// The relational layer's own surface: trees as data, the builder over them.
export { from, Rel } from './rel/builder.ts'
export type { Fold, Folds, RelationOf } from './rel/builder.ts'

export { relate } from './rel/live.ts'
export type { Relation, RelateOptions, Ordering } from './rel/live.ts'

export {
  pure,
  filter,
  join,
  agg,
  union,
  expand,
  scan,
  checkNode,
  canonNode,
  recount,
  keyOfRow,
  keyPaths,
  whyRow,
  substituteNode,
  paramsOfNode,
} from './rel/node.ts'
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
} from './rel/node.ts'

export {
  field,
  lit,
  param,
  cmp,
  and,
  or,
  not,
  math,
  some,
  evalExpr,
  canonExpr,
} from './rel/expr.ts'
export type { Expr, Row } from './rel/expr.ts'
