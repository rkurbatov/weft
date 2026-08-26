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

/** What may stand in a form: a part, or a form of its own. */
export interface Form {
  readonly [name: string]: Part<unknown> | Form
}

/** What a form comes back as: every part built, every sub-form built through. */
export type Built<F> = {
  [K in keyof F]: F[K] extends Part<infer T> ? T : F[K] extends Form ? Built<F[K]> : never
}

const isPart = (thing: Part<unknown> | Form): thing is Part<unknown> =>
  typeof (thing as Part<unknown>).build === 'function'

/**
 * The whole form: an ordinary nested structure, every field a live answer.
 *
 * Nested for real. It said "nested" and meant one level — a flat record of
 * parts — so a screen that wanted its counters under `header` and its shelves
 * under `board` had to build two forms and put them together by hand, which is
 * the sequence of operations a form exists to replace. A value is a part when
 * it can build; anything else that is a plain object is a form, and goes
 * through.
 */
export function shape<F extends Form>(F: F, options?: { name?: string }): Built<F>
export function shape(form: Form, options: { name?: string } = {}): Record<string, unknown> {
  const at = options.name ?? 'shape'
  const out: Record<string, unknown> = {}
  for (const [name, thing] of Object.entries(form)) {
    out[name] = isPart(thing)
      ? thing.build(`${at}.${name}`)
      : shape(thing, { name: `${at}.${name}` })
  }
  return out
}

/** A shorthand for the commonest condition: this field equals this value. */
export const has = (field: string, value: unknown): Expr => ({
  is: 'cmp',
  op: '==',
  left: fieldExpr(field),
  right: lit(value),
})

export type { Key }
