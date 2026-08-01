// React binding. Deliberately thin: the graph lives outside the tree,
// React is one of its outputs.

import { useCallback, useDebugValue, useMemo, useRef, useSyncExternalStore } from 'react'
import { subscribe, untracked } from '#core/graph.ts'
import type { Input, Watchable } from '#core/graph.ts'
import type { Command, CommandState } from '#core/command.ts'
import { fresh } from '#core/source.ts'
import type { Source } from '#core/source.ts'
import { heldOf } from '#core/remote.ts'
import type { Remote } from '#core/remote.ts'

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

// The promise of the answer under way. Subscribing is what raises the demand,
// so asking for the promise is what starts the load — nothing is forced and no
// flight is restarted. One promise per source while it is unsettled.
const landings = new WeakMap<Source<unknown>, Promise<void>>()

/** Resolves when the source holds a value or a refusal has settled. The first
 *  refusal decides, whatever its sort — what to do next is the caller's
 *  business, usually a boundary offering refresh(). */
export function arrivalOf<T>(feed: Source<T>): Promise<void> {
  const settled = (): boolean => {
    const state = untracked(() => feed.state.peek())
    return heldOf(state) !== undefined || state.kind === 'failed'
  }
  if (settled()) return Promise.resolve()
  const known = landings.get(feed as Source<unknown>)
  if (known !== undefined) return known
  const landing = new Promise<void>(resolve => {
    const stop = subscribe(feed.state, () => {
      if (!settled()) return
      stop()
      landings.delete(feed as Source<unknown>)
      resolve()
    })
  })
  landings.set(feed as Source<unknown>, landing)
  return landing
}

/**
 * The source's value for a tree that suspends. Only a cold start suspends:
 * once anything is held, the stale keeps showing while the fresh travels, and
 * a refusal on top of a held value stays quiet here — screens that want the
 * whole story read useSource and its flat fields instead. A refusal with
 * empty hands is thrown to the nearest boundary.
 */
export function useSourceValue<T>(feed: Source<T>, options: { within?: number } = {}): T {
  const state = useSource(feed, options)
  const held = heldOf(state)
  if (held !== undefined) return held.value
  if (state.kind === 'failed') throw state.error
  throw arrivalOf(feed)
}
