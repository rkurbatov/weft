// Projection: the base plus the replay of the book, as one derived value.
// The app states what each note does to the state — one line per kind — and
// everything else is the library's business: replay order, skipping the
// stuck, and keeping the identity of unchanged pieces so a memoized screen
// stays quiet. The identity keeping is the one deliberately impure spot, and
// it lives here, under the floor, not in application formulas.

import { cell } from '#graph/graph/graph.ts'
import type { Cell, Watchable } from '#graph/graph/graph.ts'
import type { Entry } from './outbox.ts'
import { preserve } from '#graph/data/preserve.ts'

export interface ProjectionSpec<S> {
  /** What a note of each kind does to the state. Unknown kinds pass through. */
  apply: Record<string, (state: S, args: never) => S>
  name?: string
}

/**
 * The visible state: base plus the book laid over it, in book order. Rollback
 * does not exist here — a refused note leaves the book, and the projection
 * recomputes without it. Identity of unchanged pieces is preserved, so
 * `React.memo` and equality gates keep working across replays and reloads.
 */
export function projected<S>(
  base: Watchable<S>,
  book: Watchable<readonly Entry[]>,
  spec: ProjectionSpec<S>,
): Cell<S> {
  let previous: S | undefined
  return cell<S>(
    () => {
      const start = base.get()
      const laid = book.get().reduce((state, entry) => {
        if (entry.state === 'stuck') return state
        const apply = spec.apply[entry.name]
        return apply === undefined ? state : apply(state, entry.args as never)
      }, start)
      const kept = previous === undefined ? laid : preserve(previous, laid)
      previous = kept
      return kept
    },
    { name: spec.name ?? 'projected' },
  )
}
