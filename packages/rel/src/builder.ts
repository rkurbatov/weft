// The typed builder: a chain of calls that compiles into the relational tree.
// Nothing here executes a query — every method builds a node; the tree is the
// same data `relate` runs and the corpus freezes, and the chain is merely a
// hand that TypeScript can hold: field names are literal types checked
// against the row, a comparison checks against the field's type, a join
// merges the row types under its alias, and a fold's answer types the group.
//
// The escape hatches stay what they were: a raw Expr or a closure may stand
// anywhere a typed piece can (`.filter`, `.with`), with the same price — a
// closure costs the tree its canon.
//
// Folds are declared through a toolkit callback (g => ({...})) rather than
// bare helpers, because a bare sum('field') has no row type to check the
// field against — proven the hard way in the shape study. The callback is
// structural: it runs once at build time against a static toolkit and
// returns declarations as data; it is not a per-row lambda.

import { cmp, field as fieldExpr, lit, param } from './expr.ts'
import type { Expr, Row } from './expr.ts'
import {
  agg as aggNode,
  expand as expandNode,
  filter as filterNode,
  join as joinNode,
  scan as scanNode,
  pure as pureNode,
  source as sourceNode,
  union as unionNode,
} from './node.ts'
import type { FoldDecl, RelNode, RowFn } from './node.ts'
import { relate } from './live.ts'
import type { RelateOptions, Relation } from './live.ts'
import type { Key, Table } from '#table/table.ts'
import type { Watchable } from '#graph/graph.ts'
import type {
  FieldType,
  MustBeAField,
  MustBeComparable,
  MustBeFree,
  MustBeNumber,
  MustHoldRows,
  MustMatch,
  OpFor,
  ScalarField,
} from './guards.ts'

// ── field name arithmetic ────────────────────────────────────────────────

/**
 * The row type a chain has arrived at. Every step changes it — a join merges,
 * a pick narrows, a group replaces — and this is how a caller (or a test) asks
 * what it is now, without digging through the reading surface to find out.
 */
export type RowOf<B> = B extends Rel<infer R> ? R : never

// ── fold toolkit: the carrier of the row type ────────────────────────────

declare const ANSWER: unique symbol
export interface Fold<T> {
  readonly decl: FoldDecl
  readonly [ANSWER]?: T
}

export interface Folds<R> {
  count(): Fold<number>
  sum<F extends string>(field: F & MustBeNumber<R, F>): Fold<number>
  min<F extends string>(field: F & MustBeComparable<R, F>): Fold<FieldType<R, F> | null>
  max<F extends string>(field: F & MustBeComparable<R, F>): Fold<FieldType<R, F> | null>
  /** The group gathered into an array, ordered by row key. */
  collect(): Fold<R[]>
  collectOf<F extends string>(field: F & MustBeComparable<R, F>): Fold<Array<FieldType<R, F>>>
}

const toolkit = <R>(): Folds<R> => ({
  count: () => ({ decl: { fold: 'count' } }),
  sum: f => ({ decl: { fold: 'sum', of: fieldExpr(f) } }),
  min: f => ({ decl: { fold: 'min', of: fieldExpr(f) } }),
  max: f => ({ decl: { fold: 'max', of: fieldExpr(f) } }),
  collect: () => ({ decl: { fold: 'collect' } }),
  collectOf: f => ({ decl: { fold: 'collect', of: fieldExpr(f) } }),
})

type FoldAnswers<S> = { [K in keyof S]: S[K] extends Fold<infer T> ? T : never }

/** How a scan is ordered: a field, or fields with direction. */
type ScanOrder<R> =
  | ScalarField<R>
  | ReadonlyArray<ScalarField<R> | { field: ScalarField<R>; down?: boolean }>

// ── the chain ────────────────────────────────────────────────────────────

export interface RelationOf<R> extends Omit<Relation, 'all' | 'row'> {
  readonly all: Watchable<readonly R[]>
  row(key: Key): Watchable<R | undefined>
}

export class Rel<R> {
  readonly node: RelNode
  /** Cells wired in by the chain (a live value passed to `where`); handed to
   *  `relate` by `live()` under the names the chain minted. */
  readonly params: ReadonlyMap<string, Watchable<unknown>>
  constructor(node: RelNode, params: ReadonlyMap<string, Watchable<unknown>> = new Map()) {
    this.node = node
    this.params = params
  }

  private grow<T>(node: RelNode, more?: ReadonlyMap<string, Watchable<unknown>>): Rel<T> {
    if (more === undefined || more.size === 0) return new Rel<T>(node, this.params)
    return new Rel<T>(node, new Map([...this.params, ...more]))
  }

  /** One typed comparison; chained calls are joined with `and` by filter
   *  nodes stacking. `filter` below is the door for anything richer. */
  where<F extends string>(
    field: F & MustBeComparable<R, F>,
    op: OpFor<FieldType<R, F>>,
    value: FieldType<R, F> | Watchable<FieldType<R, F>>,
  ): Rel<R> {
    if (value !== null && typeof value === 'object' && 'get' in value) {
      const name = `p${this.params.size + 1}`
      return this.grow(
        filterNode(this.node, cmp(op, fieldExpr(field), param(name))),
        new Map([[name, value as Watchable<unknown>]]),
      )
    }
    return this.grow(filterNode(this.node, cmp(op, fieldExpr(field), lit(value))))
  }

  /** The raw door: an Expr as data keeps the canon, a closure spends it. */
  filter(test: Expr | RowFn): Rel<R> {
    return this.grow(filterNode(this.node, test))
  }

  /** A computed field. The value's type is declared, not inferred — the
   *  expression is data and TS cannot see through it; `checkNode` and the
   *  oracle hold it to account instead. */
  with<N extends string, T>(
    name: N & MustBeFree<R, N>,
    of: Expr | RowFn,
  ): Rel<R & { [K in N]: T }> {
    return this.grow(pureNode(this.node, { fields: { [name]: of } }))
  }

  pick<F extends string>(...fields: Array<F & MustBeAField<R, F>>): Rel<Pick<R, F & keyof R>> {
    return this.grow(pureNode(this.node, { pick: fields }))
  }

  /** Reach the matching row of another relation; it lands under the alias.
   *  `keeping` keeps unmatched left rows, the alias then holding null —
   *  the type says so: the flag is carried into the merged row's type. */
  join<T, A extends string, F extends string, G extends string, Keep extends boolean = false>(
    other: Rel<T>,
    spec: {
      as: A & MustBeFree<R, A>
      on:
        | MustMatch<R, T, F & MustBeComparable<R, F>, G & MustBeComparable<T, G>>
        | ReadonlyArray<MustMatch<R, T, F & MustBeComparable<R, F>, G & MustBeComparable<T, G>>>
      residual?: Expr | RowFn
      keeping?: Keep
    },
  ): Rel<R & { [K in A]: Keep extends true ? T | null : T }> {
    // The types above have already said whether the pairs are lawful; here
    // they are just pairs of names.
    const on = spec.on as readonly [string, string] | ReadonlyArray<readonly [string, string]>
    const pairs = (typeof on[0] === 'string' ? [on] : on) as ReadonlyArray<
      readonly [string, string]
    >
    return this.grow(
      joinNode(this.node, other.node, {
        as: spec.as,
        on: pairs.map(([left, right]) => ({ left, right })),
        ...(spec.residual === undefined ? {} : { residual: spec.residual }),
        ...(spec.keeping === true ? { keeping: true } : {}),
      }),
      other.params,
    ) as never
  }

  /** Groups by fields, folds by the toolkit; the group's row carries the
   *  by-fields beside every fold's answer. */
  groupBy<F extends string, S extends Record<string, Fold<unknown>>>(
    by: (F & MustBeComparable<R, F>) | ReadonlyArray<F & MustBeComparable<R, F>>,
    form: (g: Folds<R>) => S,
  ): Rel<{ [K in F]: FieldType<R, K> } & FoldAnswers<S>> {
    const fields = (typeof by === 'string' ? [by] : by) as readonly string[]
    const declared = form(toolkit<R>())
    const folds: Record<string, FoldDecl> = {}
    for (const [name, fold] of Object.entries(declared)) folds[name] = fold.decl
    return this.grow(aggNode(this.node, { by: fields, folds })) as never
  }

  /** The whole relation folded into one row, alive even over nothing. */
  fold<S extends Record<string, Fold<unknown>>>(form: (g: Folds<R>) => S): Rel<FoldAnswers<S>> {
    const declared = form(toolkit<R>())
    const folds: Record<string, FoldDecl> = {}
    for (const [name, fold] of Object.entries(declared)) folds[name] = fold.decl
    return this.grow(aggNode(this.node, { by: [], folds })) as never
  }

  /** Two relations of one row type and disjoint keys, as one. */
  union(other: Rel<R>): Rel<R> {
    return this.grow(unionNode(this.node, other.node), other.params)
  }

  /** A row with a nested table unfolds into a row per nested entry; the
   *  table field is consumed, the nested row lands under the alias. */
  expand<F extends string, A extends string>(
    field: F & MustHoldRows<R, F>,
    spec: {
      as: A
      key: ReadonlyArray<keyof (FieldType<R, F> extends readonly (infer E)[] ? E : never) & string>
    },
  ): Rel<Omit<R, F> & { [K in A]: FieldType<R, F> extends readonly (infer E)[] ? E : never }> {
    return this.grow(
      expandNode(this.node, { field, as: spec.as, key: spec.key as readonly string[] }),
    ) as never
  }

  /** An ordered pass carrying a running total: `as` holds the carry BEFORE
   *  each row — its offset — and `through` the carry including it. This is
   *  what a virtualised list asks: where a row starts, and how tall the
   *  whole is. The carrier is chosen by the same door as folds. */
  scan<N extends string = never, T extends string = never, S extends string = never>(spec: {
    by: ScanOrder<R>
    step: (S & MustBeNumber<R, S>) | Expr | RowFn
    /** Name it only if the screen shows it per row: naming asks for the carry
     *  to be written into every row, and over a long list the plan takes that
     *  back — the view answers offsets either way. */
    as?: N & MustBeFree<R, N>
    through?: T & MustBeFree<R, T>
    from?: number
  }): Rel<R & { [K in N | T]: number }> {
    const order = (typeof spec.by === 'string' ? [spec.by] : spec.by) as ReadonlyArray<
      string | { field: string; down?: boolean }
    >
    return this.grow(
      scanNode(this.node, {
        order: order.map(o => (typeof o === 'string' ? { field: o } : o)),
        step: typeof spec.step === 'string' ? fieldExpr(spec.step) : spec.step,
        ...(spec.as === undefined ? {} : { as: spec.as }),
        ...(spec.through === undefined ? {} : { through: spec.through }),
        ...(spec.from === undefined ? {} : { from: spec.from }),
      }),
    ) as never
  }

  /** The tree behind the chain — what the corpus freezes and Go runs. */
  tree(): RelNode {
    return this.node
  }

  live(sources: Record<string, Table<Row>>, options?: RelateOptions): RelationOf<R> {
    const wired = Object.fromEntries(this.params)
    return relate(this.node, sources, {
      ...options,
      params: { ...wired, ...options?.params },
    }) as unknown as RelationOf<R>
  }
}

/** The chain's first link: a named source and the fields its key is made of. */
export function from<R>(
  source: string,
  key: (keyof R & string) | ReadonlyArray<keyof R & string>,
): Rel<R> {
  const fields = (typeof key === 'string' ? [key] : key) as readonly string[]
  return new Rel<R>(sourceNode(source, fields))
}
