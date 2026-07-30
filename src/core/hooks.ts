// React binding. Deliberately thin: the graph lives outside the tree,
// React is one of its outputs.

import { useCallback, useDebugValue, useMemo, useRef, useSyncExternalStore } from 'react'
import { subscribe, untracked } from '#core/graph.ts'
import type { Readable } from '#core/graph.ts'
import type { Command, CommandState } from '#core/command.ts'

/** Read a cell. The component re-renders when this value changes — nothing else. */
export function useCell<T>(source: Readable<T>): T {
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
    /** Start it; await the returned promise if the caller needs the answer. */
    start: (...args: A) => Promise<T>
    pending: boolean
    error: unknown
    result: T | undefined
    state: CommandState<T>
    reset: () => void
}

/** Hand a command to the tree: one function to start, plus its observable state. */
export function useCommand<A extends unknown[], T>(cmd: Command<A, T>): CommandHandle<A, T> {
    const state = useCell(cmd.state)
    // The identity of start must not change across renders: it goes into handlers and deps.
    const ref = useRef(cmd)
    ref.current = cmd
    const start = useCallback((...args: A) => ref.current.run(...args), [])
    const reset = useCallback(() => ref.current.reset(), [])
    return {
        start,
        reset,
        state,
        pending: state.kind === 'running',
        error: state.kind === 'failed' ? state.error : undefined,
        result: state.kind === 'done' ? state.value : undefined,
    }
}