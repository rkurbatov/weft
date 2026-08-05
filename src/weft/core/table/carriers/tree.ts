// A flat tree of block partials.
//
// Rows take slots in a plain array, an edit dirties one block, a read recounts
// the dirty blocks and joins the partials. For operations without an inverse —
// min, max — over big collections: one edit costs one block, not the whole
// collection. No cells per row: the deltas feed the array directly and the
// graph sees one answer.

import type { Change, Key } from '../table.ts'
import { TREE_SPAN } from '../plan.ts'
import type { FoldCarrier, FoldWork, Rows } from './carrier.ts'

export function treeCarrier<R, A>(work: FoldWork<R, A>, span = TREE_SPAN): FoldCarrier<R, A> {
  let rows: (R | undefined)[] = []
  let slots = new Map<Key, number>()
  let partials: A[] = []
  let dirty = new Set<number>()

  const rebuild = (over: Rows<R>): void => {
    rows = []
    slots = new Map()
    over.each(row => {
      slots.set(over.keyOf(row), rows.length)
      rows.push(row)
    })
    partials = []
    dirty = new Set()
    for (let b = 0; b * span < rows.length; b++) dirty.add(b)
  }

  const take = (changes: readonly Change<R>[]): void => {
    for (const change of changes) {
      const at = slots.get(change.key)
      if (change.next === undefined) {
        // A hole, not a shift: positions hold, the block recounts around it.
        if (at !== undefined) {
          rows[at] = undefined
          slots.delete(change.key)
          dirty.add(Math.floor(at / span))
        }
      } else if (at === undefined) {
        slots.set(change.key, rows.length)
        rows.push(change.next)
        dirty.add(Math.floor((rows.length - 1) / span))
      } else {
        rows[at] = change.next
        dirty.add(Math.floor(at / span))
      }
    }
  }

  return {
    answer(): A {
      for (const b of dirty) {
        let part = work.zero
        const first = b * span
        const last = Math.min(first + span, rows.length)
        for (let i = first; i < last; i++) {
          const row = rows[i]
          if (row !== undefined) part = work.add(part, row)
        }
        partials[b] = part
      }
      dirty.clear()
      const join = work.join as (a: A, b: A) => A // the plan grants a tree only with a join
      let whole = work.zero
      for (let b = 0; b * span < rows.length; b++) whole = join(whole, partials[b] as A)
      return whole
    },
    rebuild,
    feed(changes) {
      take(changes)
    },
  }
}
