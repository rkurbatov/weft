// Which fields of a row may be named where: something comparable to group or
// order by, something numeric to add up, and what type a named field holds.
//
// Its own file because the form, the list and the group all speak it, and the
// three of them would otherwise each carry a copy in their heads.

import type { Key } from '#weft'
import type { FoldDecl } from '#rel'

export type Scalar = string | number | boolean | null
export type ScalarField<R> = { [K in keyof R & string]: R[K] extends Scalar ? K : never }[keyof R &
  string]
export type NumericField<R> = { [K in keyof R & string]: R[K] extends number ? K : never }[keyof R &
  string]
export type FieldType<R, F> = F extends keyof R ? R[F] : never

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
