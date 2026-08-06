// The dialect's seam with React: the component is the last formula of the
// graph.
//
// `useLive` runs a formula with the same read tracking cells have — what the
// formula reads is what re-renders the component, and structural equality
// gates the rest. That is the whole of what this file adds.
//
// Everything else it offers comes from the engine's own seam at '#react',
// under the same names: a seam that renamed things would make two vocabularies
// for one behaviour, and a reader of both would never be sure they match.

import { useCallback, useRef, useSyncExternalStore } from 'react'
import { derived, subscribe, untracked } from '#weft'
import type { Derived } from '#weft'
import { alike } from '#weft'

// Passed through under their own names, not renamed: a seam that renamed
// things would make two vocabularies for one behaviour, and a reader of both
// would never be sure they match.
//
// A subset on purpose. The engine's seam also offers `useCommand` and
// `useSource` — the command and the raw state of an answer — and the dialect
// has its own words for both, `will` and `truth`. Passing them through here
// would offer two ways to say one thing, which is exactly what a dialect is
// for avoiding. An application that wants the engine's own words takes them
// from '#react' directly, as the spreadsheet example does.
export { useCell, useField, useKeepRow, useSourceValue } from '#react'

export function useLive<T>(formula: () => T): T {
  const body = useRef(formula)
  body.current = formula
  // The screen cell is born on demand and dies with the unsubscribe — never in
  // an effect: StrictMode mounts, unmounts and mounts again, and a disposed
  // cell kept in state would freeze the first frame forever. Whoever asks next
  // gets a fresh one.
  const made = useRef<Derived<T> | null>(null)
  // Born on subscription, never in a render. React may render a component and
  // throw the render away — a suspended tree, an abandoned transition — and
  // then it never subscribes, so nothing would ever take the cell down. By
  // then it has read its sources, and they hold it forever.
  const screen = useCallback((): Derived<T> => {
    made.current ??= derived(() => body.current(), { name: 'screen', equal: (a, b) => alike(a, b) })
    return made.current
  }, [])
  // The store contract: the snapshot must be the very same object between
  // change notifications. A recreated cell computes an alike tuple that is a
  // fresh object — hand back the old one whenever nothing really changed.
  const last = useRef<{ value: T } | null>(null)
  const snapshot = useCallback((): T => {
    // Without a cell yet, the value is worked out on the spot and nothing is
    // left behind. With one, its held value — that is the whole difference.
    const value = made.current === null ? untracked(() => body.current()) : made.current.peek()
    if (last.current !== null && alike(last.current.value, value)) return last.current.value
    last.current = { value }
    return value
  }, [])
  // The subscribe function must be stable: React re-subscribes whenever it
  // changes, and a blink of dropped demand is enough for a mirror to honestly
  // forget. One identity — one subscription for the component's whole life.
  const hold = useCallback(
    (onChange: () => void): (() => void) => {
      const shown = screen()
      const stop = subscribe(shown, () => onChange())
      return () => {
        stop()
        shown.dispose()
        if (made.current === shown) made.current = null
      }
    },
    [screen],
  )
  return useSyncExternalStore(hold, snapshot, snapshot)
}
