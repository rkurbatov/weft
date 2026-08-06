// What the compiler says when a field is the wrong kind.
//
// A mapped type in an argument position produces the whole union in the error
// message, and for a wide row that is a wall of text with the real complaint
// buried in it. These carry the complaint in their own name instead: the
// message reads `not assignable to 'NotANumberField<"title">'`, which says
// what is wrong and about which field.

import type { Row } from './expr.ts'

export type Scalar = string | number | boolean | null
export type ScalarField<R> = { [K in keyof R & string]: R[K] extends Scalar ? K : never }[keyof R &
  string]
export type NumericField<R> = { [K in keyof R & string]: R[K] extends number ? K : never }[keyof R &
  string]
export type RowsField<R> = {
  [K in keyof R & string]: R[K] extends readonly Row[] ? K : never
}[keyof R & string]
export type FieldType<R, F> = F extends keyof R ? R[F] : never

// ── what the compiler says when a field is the wrong kind ────────────────
//
// A mapped type in an argument position produces the whole union in the error
// message, and for a wide row that is a wall of text with the real complaint
// buried in it. These carry the complaint in their own name instead: the
// message reads `not assignable to 'NotANumberField<"title">'`, which says
// what is wrong and about which field.

export interface NotANumberField<F> {
  readonly weft: 'this field does not hold a number, and only numbers can be summed'
  readonly field: F
}

export interface NotAComparableField<F> {
  readonly weft: 'this field holds neither a number, a string nor a boolean, so it cannot be compared or grouped by'
  readonly field: F
}

export interface NotAFieldOfRows<F> {
  readonly weft: 'this field does not hold an array of rows, and only those can be expanded'
  readonly field: F
}

export interface NoSuchField<F> {
  readonly weft: 'this row has no such field'
  readonly field: F
}

export interface JoinedOnDifferentTypes<L, R> {
  readonly weft: 'the two sides of a join must be matched on fields of the same type'
  readonly left: L
  readonly right: R
}

export interface FieldAlreadyTaken<N> {
  readonly weft: 'this name is already a field of the row: adding it would hide the one there'
  readonly name: N
}

/** `F` if it names a number, otherwise a type whose name is the complaint. */
export type MustBeNumber<R, F extends string> = F extends NumericField<R> ? F : NotANumberField<F>
export type MustBeComparable<R, F extends string> =
  F extends ScalarField<R> ? F : NotAComparableField<F>
export type MustHoldRows<R, F extends string> = F extends RowsField<R> ? F : NotAFieldOfRows<F>
export type MustBeAField<R, F extends string> = F extends keyof R & string ? F : NoSuchField<F>
/** A name a row does not have yet: adding one it has would hide the old value. */
export type MustBeFree<R, N extends string> = N extends keyof R ? FieldAlreadyTaken<N> : N
/** Both sides of a join must be comparable, and comparable to each other. */
export type MustMatch<R, T, F extends string, G extends string> =
  FieldType<R, F> extends FieldType<T, G>
    ? FieldType<T, G> extends FieldType<R, F>
      ? readonly [F, G]
      : JoinedOnDifferentTypes<FieldType<R, F>, FieldType<T, G>>
    : JoinedOnDifferentTypes<FieldType<R, F>, FieldType<T, G>>

/** What a comparison may ask of a field: order needs order, `has` is the
 *  substring word and belongs to strings. */
export type OpFor<T> = [T] extends [number]
  ? '==' | '!=' | '<' | '<=' | '>' | '>='
  : [T] extends [string]
    ? '==' | '!=' | 'has'
    : '==' | '!='
