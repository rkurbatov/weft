// Groups and what is asked of them: a count, a sum, a maximum, the rows
// themselves. One shelf per value of a field, or the whole collection as one.

import { derived } from '#weft'
import type { Watchable } from '#weft'
import {
  agg as aggNode,
  field as fieldExpr,
  filter as filterNode,
  relate,
  source as sourceNode,
} from '#rel'
import type { Expr, FoldDecl, RelNode, Row } from '#rel'
import type { Table } from '#weft'
import { tableOfLive } from './live.ts'
import type { Live } from './live.ts'
import { keyFieldsOf } from './keys.ts'
import type { Answers, FieldType, NumericField, Piece, ScalarField, ScanBy } from './fields.ts'
import type { Part } from './shape.ts'

/** What one group may be asked for. The row type is carried by the toolkit,
 *  so a field name is checked against it and a typo does not compile. */
export interface Group<R> {
  /** The value this group stands under. */
  key<F extends ScalarField<R>>(field: F): Piece<FieldType<R, F>>
  count(): Piece<number>
  /**
   * A number added up over the group: a field, or a measure of your own for
   * what is not one field — a total of two, something nested, a rate. A
   * measure is a closure, so a tree holding one cannot travel to another
   * implementation; that is the price and it is stated in the tree.
   */
  sum(field: NumericField<R> | ((row: R) => number)): Piece<number>
  min<F extends ScalarField<R>>(field: F): Piece<FieldType<R, F> | null>
  max<F extends ScalarField<R>>(field: F): Piece<FieldType<R, F> | null>
  /** The group's rows themselves — no projection, no field list. Order them
   *  by a field when the shelf has an order of its own. */
  rows(order?: ScanBy<R>): Piece<R[]>
  /** One field of every row in the group. */
  rowsOf<F extends ScalarField<R>>(field: F, order?: ScanBy<R>): Piece<Array<FieldType<R, F>>>
}

export const orderOf = <R>(
  order?: ScanBy<R>,
): ReadonlyArray<{ field: string; down?: boolean }> | undefined => {
  if (order === undefined) return undefined
  const many = (typeof order === 'string' ? [order] : order) as ReadonlyArray<
    string | { field: string; down?: boolean }
  >
  return many.map(o => (typeof o === 'string' ? { field: o } : o))
}

export const toolkit = <R>(): Group<R> => ({
  // A by-field is already in the group's row: `count` of it is not needed,
  // the value is written back from the group key itself.
  key: f => ({ decl: { fold: 'min', of: fieldExpr(f) } }) as never,
  count: () => ({ decl: { fold: 'count' } }),
  sum: f =>
    ({
      decl: {
        fold: 'sum',
        of: typeof f === 'function' ? (f as (row: Row) => unknown) : fieldExpr(f),
      },
    }) as never,
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

export const partsOf = <R, S extends Record<string, Piece<unknown>>>(
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
  feed: Live<R>,
  by: F,
  form: (g: Group<R>) => S,
  where?: Expr | ((row: R) => boolean),
): Part<Watchable<Array<Answers<S>>>> {
  return group(feed, [by as string], form, where)
}

export function fold<R>(
  feed: Live<R>,
  form: (g: Group<R>) => Piece<unknown> | Record<string, Piece<unknown>>,
  where?: Expr | ((row: R) => boolean),
): Part<Watchable<unknown>> {
  const one = 'decl' in (form(toolkit<R>()) as object)
  const asRecord = (g: Group<R>): Record<string, Piece<unknown>> => {
    const asked = form(g)
    return one ? { it: asked as Piece<unknown> } : (asked as Record<string, Piece<unknown>>)
  }
  const part = group<R, Record<string, Piece<unknown>>>(feed, [], asRecord, where)
  return {
    build: name => {
      const many = part.build(name)
      return derived(
        () => {
          const first = many.get()[0] ?? {}
          return one ? (first as { it?: unknown }).it : first
        },
        { name: `${name}.one` },
      )
    },
  }
}

export function group<R, S extends Record<string, Piece<unknown>>>(
  feed: Live<R>,
  by: readonly string[],
  form: (g: Group<R>) => S,
  where?: Expr | ((row: R) => boolean),
): Part<Watchable<Array<Answers<S>>>> {
  const { folds } = partsOf<R, S>(form)
  return {
    build(name) {
      const source = feed.name
      let node: RelNode = sourceNode(source, keyFieldsOf(feed as unknown as object))
      if (where !== undefined) {
        node = filterNode(node, where as Expr | ((row: Row) => unknown))
      }
      node = aggNode(node, { by, folds })
      const live = relate(node, { [source]: tableOfLive(feed) as Table<Row> }, { name })
      return derived(() => live.all.get() as Array<Answers<S>>, { name: `${name}.rows` })
    },
  }
}
