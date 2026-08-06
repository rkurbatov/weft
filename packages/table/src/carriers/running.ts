// A running accumulator, and its honest cousin.
//
// With an inverse, one edit is one subtraction and one addition, whatever the
// collection's size. Without one, the same carrier tells the truth: it walks
// the rows again. That is why they share a file — the difference is one `if`,
// and pretending otherwise would mean two carriers that answer the same.

import type { FoldCarrier, FoldWork, Rows } from './carrier.ts'

export function runningCarrier<R, A>(work: FoldWork<R, A>): FoldCarrier<R, A> {
  let acc = work.zero

  const oracle = (rows: Rows<R>): void => {
    acc = work.zero
    rows.each(row => {
      acc = work.add(acc, row)
    })
  }

  return {
    answer: () => acc,
    rebuild(rows) {
      oracle(rows)
    },
    feed(changes, rows) {
      const sub = work.sub
      if (sub === undefined) {
        // No inverse: the collection is walked again. Honest, and the reason
        // the planner keeps this carrier for small collections only.
        oracle(rows)
        return
      }
      for (const change of changes) {
        if (change.prev !== undefined) acc = sub(acc, change.prev)
        if (change.next !== undefined) acc = work.add(acc, change.next)
      }
    },
  }
}
