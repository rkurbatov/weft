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

import { derived } from '#graph/graph.ts'
import type { Watchable } from '#graph/graph.ts'
import type { Key, Table } from '#table/table.ts'
import { field as fieldExpr, lit } from '#rel/expr.ts'
import type { Expr, Row } from '#rel/expr.ts'
import { agg as aggNode, filter as filterNode, source as sourceNode } from '#rel/node.ts'
import type { FoldDecl, RelNode } from '#rel/node.ts'
import { relate } from '#rel/live.ts'
import { tableOfFeed } from './feed.ts'
import type { Feed } from './feed.ts'

/**
 * A part of a form builds whatever that part actually is.
 *
 * An aggregate is one value, so its part builds a cell. A list is not one
 * value — it is a window, a total size and a row's place — so its part builds
 * exactly that. Forcing both into a cell was the mistake: it made a form of
 * lists read `board.all.peek().size`, which is worse than the code it replaced.
 */
export interface Part<T> {
  readonly build: (name: string) => T
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
