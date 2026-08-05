// React binding. Deliberately thin: the graph lives outside the tree,
// React is one of its outputs.

import {
  useCallback,
  useDebugValue,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react'
import { subscribe, untracked } from '#weft'
import type { Input, Key, Watchable } from '#weft'
import type { Command, CommandState } from '#weft'
import { arrivalOf, fresh } from '#weft'
import type { Fault, Source } from '#weft'
import { heldOf } from '#weft'
import type { Remote } from '#weft'

/** Read a cell. The component re-renders when this value changes — nothing else. */
export function useCell<T>(source: Watchable<T>): T {
  const store = useMemo(
    () => ({
      subscribe: (onChange: () => void) => subscribe(source, onChange),
      snapshot: () => untracked(() => source.get()),
    }),
    [source],
  )
  const value = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  useDebugValue(value)
  return value
}

export interface CommandHandle<A extends unknown[], T> {
  /** Start it — the same word as on the command itself. Await if the answer matters. */
  run: (...args: A) => Promise<T>
  pending: boolean
  error: unknown
  result: T | undefined
  state: CommandState<T>
  reset: () => void
}

/** Hand a command to the tree: one function to start, plus its observable state. */
export function useCommand<A extends unknown[], T>(cmd: Command<A, T>): CommandHandle<A, T> {
  const state = useCell(cmd.state)
  // The identity of run must not change across renders: it goes into handlers and deps.
  const ref = useRef(cmd)
  ref.current = cmd
  const run = useCallback((...args: A) => ref.current.run(...args), [])
  const reset = useCallback(() => ref.current.reset(), [])
  return {
    run,
    reset,
    state,
    pending: state.kind === 'running',
    error: state.kind === 'failed' ? state.error : undefined,
    result: state.kind === 'done' ? state.value : undefined,
  }
}

/**
 * Read a source, stating how fresh this screen needs it. Mounting is the
 * requirement; unmounting withdraws it, and a source nobody needs goes quiet.
 */
export function useSource<T>(feed: Source<T>, options: { within?: number } = {}): Remote<T> {
  const { within } = options
  const view = useMemo(
    () => (within === undefined ? feed.state : fresh(feed, within)),
    [feed, within],
  )
  return useCell(view)
}

export interface InputBinding {
  value: string
  onChange: (event: { target: { value: string } }) => void
}

/** The two-way seam for a text field: the input's value in, keystrokes out.
 *  Spread it onto an <input>, <textarea> or <select> and be done. */
export function useInputBinding(field: Input<string>): InputBinding {
  const value = useCell(field)
  const ref = useRef(field)
  ref.current = field
  const onChange = useCallback(
    (event: { target: { value: string } }) => ref.current.set(event.target.value),
    [],
  )
  return { value, onChange }
}

/**
 * The source's value for a tree that suspends. Only a cold start suspends:
 * once anything is held, the stale keeps showing while the fresh travels, and
 * a refusal on top of a held value stays quiet here — screens that want the
 * whole story read useSource and its flat fields instead. A refusal with
 * empty hands is thrown to the nearest boundary.
 */
export function useSourceValue<T>(feed: Source<T>, options: SourceValueOptions = {}): T {
  const state = useSource(feed, options)
  const held = heldOf(state)
  if (held !== undefined) return held.value
  if (state.kind !== 'failed') throw arrivalOf(feed)
  if (!repeating(state.fault, state.attempt, options)) throw state.error
  // A refusal the source will try again on its own is not news yet. Waiting is
  // the honest answer: an error boundary shown here stays shown, and a retry
  // that succeeds two seconds later cannot take it down — the screen would sit
  // red over a graph that is perfectly well.
  throw afterAttempt(feed, state.attempt)
}

/**
 * Waiting for the next attempt, rather than for an arrival.
 *
 * `arrivalOf` counts a refusal as an arrival, so throwing it while refusals
 * repeat would resolve at once and spin the render. This settles when the
 * state moves on from the refusal we already saw: a value, or one more attempt
 * — either way there is something new to say.
 */
const attempts = new WeakMap<object, { attempt: number; landing: Promise<void> }>()

function afterAttempt<T>(feed: Source<T>, attempt: number): Promise<void> {
  const known = attempts.get(feed)
  if (known !== undefined && known.attempt === attempt) return known.landing
  const landing = new Promise<void>(resolve => {
    const stop = subscribe(feed.state, () => {
      const now = untracked(() => feed.state.peek())
      const moved = heldOf(now) !== undefined || (now.kind === 'failed' && now.attempt !== attempt)
      if (!moved) return
      stop()
      attempts.delete(feed)
      resolve()
    })
  })
  attempts.set(feed, { attempt, landing })
  return landing
}

export interface SourceValueOptions {
  /** Treat what is held as good enough for this long; older starts a load. */
  within?: number
  /**
   * How many refusals to wait through before showing the error. A refusal the
   * source repeats by itself is not news until it stops being repeated.
   * Default 3; `0` shows the very first one.
   */
  patience?: number
}

/** Is this refusal one the source will try again by itself, and soon? */
function repeating(fault: Fault, attempt: number, options: SourceValueOptions): boolean {
  // Permanent and rejected are the world's answer, not a hiccup: no repeat is
  // coming, so waiting for one would hang the screen forever.
  if (fault !== 'transient' && fault !== 'unknown') return false
  return attempt <= (options.patience ?? 3)
}

export interface KeepRowOptions<R> {
  /** The scrolling element. */
  box: { current: HTMLElement | null }
  /** Row height in pixels; the list is assumed to be even-height. */
  rowHeight: number
  /** Index of the first drawn row. */
  first: number
  /** The rows drawn right now, top first. */
  rows: readonly R[]
  keyOf: (row: R) => Key
  /** Where that key stands in the ordered view now; below zero means gone. */
  rankOf: (key: Key) => number
  /** Change this to forget the held row — a different list, a different order. */
  reset?: unknown
}

/**
 * Hold the top drawn row in place while the list moves under it.
 *
 * A live list gains and loses rows above the window, and every such move shifts
 * the indices the window is positioned by — the screen would jump. This keeps
 * the row the reader is looking at at the same pixel by scrolling the box by
 * exactly as much as the row moved; the scroll handler then catches the window
 * up, and overscan covers the frame in between.
 */
export function useKeepRow<R>(options: KeepRowOptions<R>): void {
  const { box, rowHeight, first, rows, keyOf, rankOf, reset } = options
  const held = useRef<{ key: Key; rank: number; of: unknown } | null>(null)

  useLayoutEffect(() => {
    const anchor = held.current
    if (anchor !== null && Object.is(anchor.of, reset)) {
      const stands = rankOf(anchor.key)
      if (stands >= 0 && stands !== anchor.rank) {
        const view = box.current
        if (view !== null) view.scrollTop += (stands - anchor.rank) * rowHeight
        held.current = { ...anchor, rank: stands }
        return // the same row, restated where it now stands
      }
    }
    const top = rows[0]
    held.current = top === undefined ? null : { key: keyOf(top), rank: first, of: reset }
  })
}

export { arrivalOf } from '#weft'
