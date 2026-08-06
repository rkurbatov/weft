// A form: the shape of the answer a screen needs, written as a structure
// rather than as a sequence of operations.
//
// Its parts live beside this file — fields.ts says which field may be named
// where, group.ts holds shelves and aggregates, list.ts the windows, keys.ts
// learns what a row's key is made of — and this one only says what a part is
// and puts a form together.

import { field as fieldExpr, lit } from '#rel'
import type { Expr } from '#rel'
import type { Key } from '#weft'

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

/** A shorthand for the commonest condition: this field equals this value. */
export const has = (field: string, value: unknown): Expr => ({
  is: 'cmp',
  op: '==',
  left: fieldExpr(field),
  right: lit(value),
})

export type { Key }
