// Which fields of a row may be named where: something comparable to group or
// order by, something numeric to add up, and what type a named field holds.
//
// Its own file because the form, the list and the group all speak it, and the
// three of them would otherwise each carry a copy in their heads.
//
// The four field types themselves come from the relational layer and are only
// passed through: they used to stand here as a word-for-word second copy, and
// one of the two would have drifted the first time either changed.

import type { FieldType, FoldDecl, NumericField, Scalar, ScalarField } from '#rel'
export type { FieldType, NumericField, Scalar, ScalarField }

declare const ANSWER: unique symbol
export interface Piece<T> {
  readonly decl: FoldDecl
  readonly [ANSWER]?: T
}

export type Answers<S> = { [K in keyof S]: S[K] extends Piece<infer T> ? T : never }

/** How rows inside a group are ordered: a field, or fields with direction. */
export type ScanBy<R> =
  | ScalarField<R>
  | ReadonlyArray<ScalarField<R> | { field: ScalarField<R>; down?: boolean }>
