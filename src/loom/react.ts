// The seam: the component is the last formula of the graph. useLive runs a
// formula with the same read tracking cells have — what the formula reads is
// what re-renders the component, structural equality gates the rest.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { cell, subscribe } from '../core/graph.ts'
import type { Cell } from '../core/graph.ts'
import { alike } from '../core/table.ts'

export { useInputBinding as useField, useSourceValue, arrivalOf } from '../react/hooks.ts'

export function useLive<T>(formula: () => T): T {
  const body = useRef(formula)
  body.current = formula
  const [screen] = useState<Cell<T>>(() =>
    cell(() => body.current(), { name: 'screen', equal: (a, b) => alike(a, b) }),
  )
  useEffect(() => () => screen.dispose(), [screen])
  return useSyncExternalStore(
    onChange => subscribe(screen, () => onChange()),
    () => screen.peek(),
    () => screen.peek(),
  )
}
