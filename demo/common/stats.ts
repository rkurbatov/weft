// Instrumentation, identical on both sides: how many cells actually re-rendered
// and how long a change took to settle. The point of the demo is these numbers.

import { useEffect, useRef, useState } from 'react'

export interface Counters {
  cellRenders: number
  gridRenders: number
  lastEdit: string
  lastEditMs: number
  lastEditRenders: number
}

const counters: Counters = {
  cellRenders: 0,
  gridRenders: 0,
  lastEdit: '—',
  lastEditMs: 0,
  lastEditRenders: 0,
}

const listeners = new Set<() => void>()

function changed(): void {
  for (const listener of listeners) listener()
}

export function countCellRender(): void {
  counters.cellRenders++
}

export function countGridRender(): void {
  counters.gridRenders++
}

export function resetCounters(): void {
  counters.cellRenders = 0
  counters.gridRenders = 0
  counters.lastEdit = '—'
  counters.lastEditMs = 0
  counters.lastEditRenders = 0
  changed()
}

/**
 * Time one edit and count the cell renders it caused. React paints after the
 * change, so the count is taken on the next frame rather than straight away.
 */
export function timeEdit(what: string, edit: () => void): void {
  const before = counters.cellRenders
  const started = performance.now()
  edit()
  const took = performance.now() - started
  requestAnimationFrame(() => {
    counters.lastEdit = what
    counters.lastEditMs = Math.round(took * 100) / 100
    counters.lastEditRenders = counters.cellRenders - before
    changed()
  })
}

/** Re-read the counters a few times a second; the numbers themselves are plain. */
export function useCounters(): Counters {
  const [, bump] = useState(0)
  useEffect(() => {
    const listener = (): void => bump(n => n + 1)
    listeners.add(listener)
    const tick = setInterval(listener, 250)
    return () => {
      listeners.delete(listener)
      clearInterval(tick)
    }
  }, [])
  return counters
}

/** How many times this component has rendered, without causing a render itself. */
export function useRenderCount(): number {
  const count = useRef(0)
  count.current++
  return count.current
}
