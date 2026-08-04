// The shape of the answer, declared once and kept true.
//
// Every query surface in use asks for a process — filter, then join, then
// group. A React developer has been taught the opposite for ten years: a
// component is the shape of the answer at the current state, and how it gets
// there is the machine's business. So this is what a query looks like here:
// the structure the screen wants, written as the structure the screen wants,
// compiled into the relational tree underneath. Groups nest instead of
// flattening, because our algebra has `collect`/`expand` and SQL does not.
// A link is `reach` — take the row this one points at — and an unmatched
// link is `null` in the type, which is `keeping` wearing TypeScript's own
// grammar. There is no projection to write: demand already knows what the
// screen reads.
//
// The escape hatch is the same as everywhere: a closure may stand in for any
// expression, and the tree honestly loses its canon.

import { cell } from '../weft/core/graph/graph.ts'
import type { Watchable } from '../weft/core/graph/graph.ts'
import type { Key, Table } from '../weft/core/table/table.ts'
import { field as fieldExpr, lit } from '../weft/rel/expr.ts'
import type { Expr, Row } from '../weft/rel/expr.ts'
import { agg as aggNode, filter as filterNode, source as sourceNode } from '../weft/rel/node.ts'
import type { FoldDecl, RelNode } from '../weft/rel/node.ts'
import { relate } from '../weft/rel/live.ts'
import { tableOfFeed } from './feed.ts'
import type { Feed } from './feed.ts'

type Scalar = string | number | boolean | null
type ScalarField<R> = { [K in keyof R & string]: R[K] extends Scalar ? K : never }[keyof R & string]
type NumericField<R> = { [K in keyof R & string]: R[K] extends number ? K : never }[keyof R &
  string]
type FieldType<R, F> = F extends keyof R ? R[F] : never

declare const ANSWER: unique symbol
interface Piece<T> {
  readonly decl: FoldDecl
  readonly [ANSWER]?: T
}

/** What one group may be asked for. The row type is carried by the toolkit,
 *  so a field name is checked against it and a typo does not compile. */
export interface Group<R> {
  /** The value this group stands under. */
  key<F extends ScalarField<R>>(field: F): Piece<FieldType<R, F>>
  count(): Piece<number>
  sum(field: NumericField<R>): Piece<number>
  min<F extends ScalarField<R>>(field: F): Piece<FieldType<R, F> | null>
  max<F extends ScalarField<R>>(field: F): Piece<FieldType<R, F> | null>
  /** The group's rows themselves — no projection, no field list. Order them
   *  by a field when the shelf has an order of its own. */
  rows(order?: ScanBy<R>): Piece<R[]>
  /** One field of every row in the group. */
  rowsOf<F extends ScalarField<R>>(field: F, order?: ScanBy<R>): Piece<Array<FieldType<R, F>>>
}

type Answers<S> = { [K in keyof S]: S[K] extends Piece<infer T> ? T : never }

/** How rows inside a group are ordered: a field, or fields with direction. */
export type ScanBy<R> =
  | ScalarField<R>
  | ReadonlyArray<ScalarField<R> | { field: ScalarField<R>; down?: boolean }>

const orderOf = <R>(
  order?: ScanBy<R>,
): ReadonlyArray<{ field: string; down?: boolean }> | undefined => {
  if (order === undefined) return undefined
  const many = (typeof order === 'string' ? [order] : order) as ReadonlyArray<
    string | { field: string; down?: boolean }
  >
  return many.map(o => (typeof o === 'string' ? { field: o } : o))
}

const toolkit = <R>(): Group<R> => ({
  // A by-field is already in the group's row: `count` of it is not needed,
  // the value is written back from the group key itself.
  key: f => ({ decl: { fold: 'min', of: fieldExpr(f) } }) as never,
  count: () => ({ decl: { fold: 'count' } }),
  sum: f => ({ decl: { fold: 'sum', of: fieldExpr(f) } }),
  min: f => ({ decl: { fold: 'min', of: fieldExpr(f) } }),
  max: f => ({ decl: { fold: 'max', of: fieldExpr(f) } }),
  rows: order => {
    const by = orderOf<R>(order)
    return { decl: { fold: 'collect', ...(by === undefined ? {} : { by }) } } as never
  },
  rowsOf: (f, order) => {
    const by = orderOf<R>(order)
    return {
      decl: { fold: 'collect', of: fieldExpr(f), ...(by === undefined ? {} : { by }) },
    } as never
  },
})

interface Part<T> {
  readonly build: (name: string) => Watchable<T>
}

const partsOf = <R, S extends Record<string, Piece<unknown>>>(
  form: (g: Group<R>) => S,
): { folds: Record<string, FoldDecl>; names: string[] } => {
  const declared = form(toolkit<R>())
  const folds: Record<string, FoldDecl> = {}
  const names: string[] = []
  for (const [name, piece] of Object.entries(declared)) {
    folds[name] = piece.decl
    names.push(name)
  }
  return { folds, names }
}

/** Rows grouped by a field; the form describes one group. */
export function byEach<R, F extends ScalarField<R>, S extends Record<string, Piece<unknown>>>(
  feed: Feed<R>,
  by: F,
  form: (g: Group<R>) => S,
  where?: Expr | ((row: R) => boolean),
): Part<Array<Answers<S>>> {
  return group(feed, [by as string], form, where)
}

/** Everything at once, as one answer — alive even over nothing. */
export function fold<R, S extends Record<string, Piece<unknown>>>(
  feed: Feed<R>,
  form: (g: Group<R>) => S,
  where?: Expr | ((row: R) => boolean),
): Part<Answers<S>> {
  const part = group<R, S>(feed, [], form, where)
  return {
    build: name => {
      const many = part.build(name)
      return cell(() => (many.get()[0] ?? {}) as Answers<S>, { name: `${name}.one` })
    },
  }
}

function group<R, S extends Record<string, Piece<unknown>>>(
  feed: Feed<R>,
  by: readonly string[],
  form: (g: Group<R>) => S,
  where?: Expr | ((row: R) => boolean),
): Part<Array<Answers<S>>> {
  const { folds } = partsOf<R, S>(form)
  return {
    build(name) {
      const source = feed.name
      let node: RelNode = sourceNode(source, keyFieldsOf(feed as unknown as object))
      if (where !== undefined) {
        node = filterNode(node, where as Expr | ((row: Row) => unknown))
      }
      node = aggNode(node, { by, folds })
      const live = relate(node, { [source]: tableOfFeed(feed) as Table<Row> }, { name })
      return cell(() => live.all.get() as Array<Answers<S>>, { name: `${name}.rows` })
    },
  }
}

/** A feed declares its key by function, so the tree is told the field name
 *  once, here — the one place the two spellings meet. */
const keyFields = new WeakMap<object, readonly string[]>()
export function keyedBy<R>(feed: Feed<R>, ...fields: Array<keyof R & string>): Feed<R> {
  keyFields.set(feed as unknown as object, fields)
  return feed
}
const keyFieldsOf = (feed: object): readonly string[] => keyFields.get(feed) ?? ['id']

/** The whole form: an ordinary nested structure, every field a live answer. */
export function shape<Form extends Record<string, Part<unknown>>>(
  form: Form,
  options: { name?: string } = {},
): { [K in keyof Form]: Form[K] extends Part<infer T> ? Watchable<T> : never } {
  const out: Record<string, Watchable<unknown>> = {}
  for (const [name, part] of Object.entries(form)) {
    out[name] = part.build(`${options.name ?? 'shape'}.${name}`)
  }
  return out as never
}

export const has = (field: string, value: unknown): Expr => ({
  is: 'cmp',
  op: '==',
  left: fieldExpr(field),
  right: lit(value),
})

export type { Key }
