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

/**
 * A part of a form builds whatever that part actually is.
 *
 * An aggregate is one value, so its part builds a cell. A list is not one
 * value — it is a window, a total size and a row's place — so its part builds
 * exactly that. Forcing both into a cell was the mistake: it made a form of
 * lists read `board.all.peek().size`, which is worse than the code it replaced.
 */
interface Part<T> {
  readonly build: (name: string) => T
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
): Part<Watchable<Array<Answers<S>>>> {
  return group(feed, [by as string], form, where)
}

/**
 * Everything at once, as one answer — alive even over nothing.
 *
 * Asked for several numbers, it answers with a record of them; asked for one,
 * it answers with that one. A form of a single number should not have to be
 * unwrapped by its caller.
 */
export function fold<R, T>(
  feed: Feed<R>,
  form: (g: Group<R>) => Piece<T>,
  where?: Expr | ((row: R) => boolean),
): Part<Watchable<T>>
export function fold<R, S extends Record<string, Piece<unknown>>>(
  feed: Feed<R>,
  form: (g: Group<R>) => S,
  where?: Expr | ((row: R) => boolean),
): Part<Watchable<Answers<S>>>
export function fold<R>(
  feed: Feed<R>,
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
      return cell(
        () => {
          const first = many.get()[0] ?? {}
          return one ? (first as { it?: unknown }).it : first
        },
        { name: `${name}.one` },
      )
    },
  }
}

function group<R, S extends Record<string, Piece<unknown>>>(
  feed: Feed<R>,
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
      const live = relate(node, { [source]: tableOfFeed(feed) as Table<Row> }, { name })
      return cell(() => live.all.get() as Array<Answers<S>>, { name: `${name}.rows` })
    },
  }
}

/**
 * Which fields make a row's key.
 *
 * A feed states its key as a function — `key: g => g.id` — and the relational
 * tree needs the field names, because a tree is data and a closure is not. So
 * the function is run once over a row that records what it is asked for: what
 * it reads is what the key is made of. A composite key works the same way,
 * since both reads are seen.
 *
 * If the function reads nothing recognisable — a key computed from the air —
 * the fields are stated by hand with `keyedBy`, and if neither works the tree
 * refuses to be built rather than guessing.
 */
const keyFields = new WeakMap<object, readonly string[]>()

export function keyedBy<R>(feed: Feed<R>, ...fields: Array<keyof R & string>): Feed<R> {
  keyFields.set(feed as unknown as object, fields)
  return feed
}

function fieldsRead(keyOf: (row: never) => Key): readonly string[] {
  const seen: string[] = []
  const spy = new Proxy(
    {},
    {
      get(_target, name) {
        if (
          typeof name === 'string' &&
          name !== 'toString' &&
          name !== Symbol.toPrimitive.toString()
        )
          seen.push(name)
        // A string that also survives arithmetic and template literals.
        return ''
      },
      has: () => true,
    },
  )
  try {
    keyOf(spy as never)
  } catch {
    // A key function doing something clever with the row: nothing to learn.
    return []
  }
  return [...new Set(seen)]
}

const keyFieldsOf = (feed: object): readonly string[] => {
  const stated = keyFields.get(feed)
  if (stated !== undefined) return stated
  const learnt = fieldsRead((feed as { keyOf?: (row: never) => Key }).keyOf ?? (() => ''))
  if (learnt.length > 0) {
    keyFields.set(feed, learnt)
    return learnt
  }
  throw new Error(
    "weft: cannot tell which fields make this feed's key — state them with keyedBy(feed, ...)",
  )
}

export interface ListView<R> {
  /** The rows of the window, in order. Wakes only when the window itself moves. */
  rows: Watchable<readonly R[]>
  /** How many rows there are in all — the scrollbar's number, not the window's. */
  size: Watchable<number>
  /** A window of one's own, for a screen that decides its own bounds. */
  window: (from: number, to: number) => Watchable<readonly R[]>
  /** Where a row stands in the order, or -1 when it is not in this list. */
  place: (key: Key) => number
}

export interface ListSpec<R> {
  /** Which rows belong here. A formula may decide, and then the list follows it. */
  where?: (row: R) => boolean
  /** The order. A field name, or a comparison of your own. */
  order: ScalarField<R> | ((a: R, b: R) => number)
  /** Latest first for a field order. */
  down?: boolean
  /**
   * The window a screen actually shows. Both ends may be live: scrolling moves
   * a cell, and only the window's own rows wake. Without a window the whole
   * list is the answer, which is right for a shelf of twenty and wrong for a
   * shelf of a hundred thousand.
   */
  window?: { from: Watchable<number>; size: number }
}

/**
 * A list as part of a form: filtered, ordered, and windowed.
 *
 * Groups answer with their rows, which is right while a group is small. A
 * shelf a person scrolls is not small, and its answer is the window — so it is
 * stated here rather than left to the caller to slice afterwards.
 */
export function list<R>(feed: Feed<R>, spec: ListSpec<R>): Part<ListView<R>> {
  return {
    build(name) {
      const part = spec.where === undefined ? feed : feed.only(spec.where, `${name}.only`)
      const compare =
        typeof spec.order === 'function'
          ? spec.order
          : (a: R, b: R): number => {
              const left = a[spec.order as keyof R]
              const right = b[spec.order as keyof R]
              const sign = left === right ? 0 : left < right ? -1 : 1
              return spec.down === true ? -sign : sign
            }
      const sorted = part.sortedBy(compare, `${name}.order`)
      const window = spec.window
      const rows =
        window === undefined
          ? cell(() => part.rows.get(), { name: `${name}.rows` })
          : cell(() => sorted.window(window.from.get(), window.from.get() + window.size).get(), {
              name: `${name}.window`,
            })
      return {
        rows,
        size: sorted.size,
        window: (from, to) => sorted.window(from, to),
        place: sorted.place,
      }
    },
  }
}

/**
 * One list per value of a field: the shelves of a screen, taken from the data
 * rather than written out.
 *
 * Four shelves by status used to be four predicates and the same order spelled
 * four times, and adding a status meant editing the screen. Here the field is
 * named once; a shelf is built the first time it is asked for and kept after,
 * so a value nobody looks at costs nothing.
 */
export function listsBy<R, F extends ScalarField<R>, Whole extends string = never>(
  feed: Feed<R>,
  field: F,
  spec: Omit<ListSpec<R>, 'where'> & {
    /**
     * A shelf holding everything, under this name, beside the ones the field
     * gives. Screens nearly always want it, and building it here keeps the
     * whole set in one place — a shelf is a shelf, whether a field named it or
     * not.
     */
    whole?: Whole
  },
): Part<Record<Extract<FieldType<R, F>, string | number> | Whole, ListView<R>>> {
  return {
    build(name) {
      const shelves = new Map<string, ListView<R>>()
      const shelfFor = (value: string): ListView<R> => {
        const standing = shelves.get(value)
        if (standing !== undefined) return standing
        const made = list(
          feed,
          value === spec.whole
            ? spec
            : { ...spec, where: row => String(row[field as unknown as keyof R]) === value },
        ).build(`${name}.${value}`)
        shelves.set(value, made)
        return made
      }
      return new Proxy(
        {},
        {
          get: (_target, key) => (typeof key === 'string' ? shelfFor(key) : undefined),
          has: () => true,
          ownKeys: () => [...shelves.keys()],
          getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
        },
      ) as Record<Extract<FieldType<R, F>, string | number> | Whole, ListView<R>>
    },
  }
}

/** The whole form: an ordinary nested structure, every field a live answer. */
export function shape<Form extends Record<string, Part<unknown>>>(
  form: Form,
  options: { name?: string } = {},
): { [K in keyof Form]: Form[K] extends Part<infer T> ? T : never } {
  const out: Record<string, unknown> = {}
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
