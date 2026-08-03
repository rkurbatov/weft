// The seam: the component is the last formula of the graph. useLive runs a
// formula with the same read tracking cells have — what the formula reads is
// what re-renders the component, structural equality gates the rest.

import { useCallback, useRef, useSyncExternalStore } from 'react'
import { cell, subscribe } from '#core/graph.ts'
import type { Cell } from '#core/graph.ts'
import { alike } from '#core/table.ts'

export { useInputBinding as useField } from '#weft/react'

export function useLive<T>(formula: () => T): T {
  const body = useRef(formula)
  body.current = formula
  // The screen cell is born on demand and dies with the unsubscribe — never in
  // an effect: StrictMode mounts, unmounts and mounts again, and a disposed
  // cell kept in state would freeze the first frame forever. Whoever asks next
  // gets a fresh one.
  const made = useRef<Cell<T> | null>(null)
  const screen = useCallback((): Cell<T> => {
    made.current ??= cell(() => body.current(), { name: 'screen', equal: (a, b) => alike(a, b) })
    return made.current
  }, [])
  // The store contract: the snapshot must be the very same object between
  // change notifications. A recreated cell computes an alike tuple that is a
  // fresh object — hand back the old one whenever nothing really changed.
  const last = useRef<{ value: T } | null>(null)
  const snapshot = useCallback((): T => {
    const value = screen().peek()
    if (last.current !== null && alike(last.current.value, value)) return last.current.value
    last.current = { value }
    return value
  }, [screen])
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
