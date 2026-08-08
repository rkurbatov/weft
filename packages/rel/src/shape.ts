// The nodes of the relational layer, as data.
//
// A tree of these is a value: it can be canonicalised, hashed, sent to a
// worker, written into a scenario file and executed by another implementation
// in another language. That is the whole reason the layer describes what to
// compute rather than closing over how.
//
// The shape is not this library's invention: it is the IR of the Warp
// language, carried over — eight of its fourteen primitives under the same
// names (source, pure, filter, join, union, expand, agg, scan), the oracle
// as its C1, `keeping` as its outer join, `whyRow` as provenance on demand,
// and the node hash as its correspondence rule. The six that are absent are
// absent for four different reasons: `opaque` dissolves into an ordinary
// derived over a whole view, and `probe` is what `subscribe` already is (so
// the word `probe` stays reserved for that meaning); `lens` died in the
// language itself; `foreign` is meaningless where every function is host
// code and purity is not enforced; `fix` and `mend` are genuine trades —
// recursion lacks the type-checked monotonicity that makes it safe there,
// and per-row annotations, which is what `mend` rides on, would cost an
// object per row, so one semiring (Z, differences) is built as machinery
// instead: the change log. Disputes about this layer's design are settled in
// the language corpus; settling them anew here means diverging from the
// source.

/** The escape hatch: any expression may be a function instead. */

import type { Expr, Row } from './expr.ts'
export type { Row }

export type RowFn = (row: Row) => unknown

export interface SourceNode {
  prim: 'source'
  /** Which named source feeds this leaf. */
  source: string
  /** Field names whose values form a row's key, in order. */
  key: readonly string[]
}

export interface PureNode {
  prim: 'pure'
  input: RelNode
  /** Computed fields; each sees the original row, not its siblings. */
  fields?: Record<string, Expr | RowFn>
  /** Projection: which fields survive. Key fields must. */
  pick?: readonly string[]
}

export interface FilterNode {
  prim: 'filter'
  input: RelNode
  test: Expr | RowFn
}

export interface JoinNode {
  prim: 'join'
  left: RelNode
  right: RelNode
  /** The right row lands nested under this name in the merged row. */
  as: string
  /** Equi keys: left field == right field, both top-level names. */
  on: ReadonlyArray<{ left: string; right: string }>
  /** Over the merged row; a pair failing it is not a match. */
  residual?: Expr | RowFn
  /** All left rows survive; an unmatched right side is null, its fields t?. */
  keeping?: boolean
}

export type FoldDecl =
  | { fold: 'count' }
  | { fold: 'sum'; of: Expr | RowFn }
  | { fold: 'min'; of: Expr | RowFn }
  | { fold: 'max'; of: Expr | RowFn }
  /** The group gathered into an array, ordered by row key — the one order two
   *  implementations can agree on. The inverse of a future expand. */
  | { fold: 'collect'; of?: Expr | RowFn; by?: ReadonlyArray<{ field: string; down?: boolean }> }
  /** The escape hatch: a passport of closures. Non-canonical by nature. */
  | {
      fold: 'custom'
      zero: unknown
      add: (acc: unknown, row: Row) => unknown
      sub?: (acc: unknown, row: Row) => unknown
      join?: (a: unknown, b: unknown) => unknown
    }

export interface AggNode {
  prim: 'agg'
  input: RelNode
  /** Group keys: top-level fields of the input row. Empty folds the whole
   *  table into one row, which then exists even over an empty input. */
  by: readonly string[]
  /** Named folds; each name becomes an output field beside the by-fields. */
  folds: Record<string, FoldDecl>
}

export interface UnionNode {
  prim: 'union'
  left: RelNode
  right: RelNode
}

export interface ExpandNode {
  prim: 'expand'
  input: RelNode
  /** The field holding a nested table — an array of rows. It is consumed:
   *  the expanded rows carry every other parent field, not the table itself. */
  field: string
  /** The nested row lands under this name, as a join's right side does. */
  as: string
  /** Key fields inside a nested row; with the parent's key they are the
   *  expanded row's identity. Two nested rows under one parent must differ. */
  key: readonly string[]
}

export interface ScanNode {
  prim: 'scan'
  input: RelNode
  /** The order the pass follows: fields, each ascending or descending. */
  order: ReadonlyArray<{ field: string; down?: boolean }>
  /** What each row contributes to the carry. */
  step: Expr | RowFn
  /** A field to write the carry BEFORE this row into. Optional on purpose:
   *  a scan always answers `offsetOf`/`at` through its view, and writing the
   *  number into every row is a separate, and often wrong, request — see the
   *  plan's `form`. */
  as?: string
  /** The carry including this row, when the screen wants both ends. */
  through?: string
  /** Where the pass starts. */
  from?: number
}

export type RelNode =
  | SourceNode
  | PureNode
  | FilterNode
  | JoinNode
  | AggNode
  | UnionNode
  | ExpandNode
  | ScanNode

export const source = (name: string, key: readonly string[]): SourceNode => ({
  prim: 'source',
  source: name,
  key,
})
export const pure = (
  input: RelNode,
  attrs: { fields?: Record<string, Expr | RowFn>; pick?: readonly string[] },
): PureNode => ({ prim: 'pure', input, ...attrs })
export const filter = (input: RelNode, test: Expr | RowFn): FilterNode => ({
  prim: 'filter',
  input,
  test,
})
export const agg = (
  input: RelNode,
  attrs: { by: readonly string[]; folds: Record<string, FoldDecl> },
): AggNode => ({ prim: 'agg', input, ...attrs })
export const union = (left: RelNode, right: RelNode): UnionNode => ({
  prim: 'union',
  left,
  right,
})
export const scan = (
  input: RelNode,
  attrs: {
    order: ReadonlyArray<{ field: string; down?: boolean }>
    step: Expr | RowFn
    as?: string
    through?: string
    from?: number
  },
): ScanNode => ({ prim: 'scan', input, ...attrs })
export const expand = (
  input: RelNode,
  attrs: { field: string; as: string; key: readonly string[] },
): ExpandNode => ({ prim: 'expand', input, ...attrs })
export const join = (
  left: RelNode,
  right: RelNode,
  attrs: {
    as: string
    on: ReadonlyArray<{ left: string; right: string }>
    residual?: Expr | RowFn
    keeping?: boolean
  },
): JoinNode => ({ prim: 'join', left, right, ...attrs })
