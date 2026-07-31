// React binding. Deliberately thin: the graph lives outside the tree,
// React is one of its outputs.

import { useCallback, useDebugValue, useMemo, useRef, useSyncExternalStore } from "react";
import { subscribe, untracked } from "#core/graph.ts";
import type { Watchable } from "#core/graph.ts";
import type { Command, CommandState } from "#core/command.ts";
import { fresh } from "#core/source.ts";
import type { Source } from "#core/source.ts";
import type { Remote } from "#core/remote.ts";

/** Read a cell. The component re-renders when this value changes — nothing else. */
export function useCell<T>(source: Watchable<T>): T {
  const store = useMemo(
    () => ({
      subscribe: (onChange: () => void) => subscribe(source, onChange),
      snapshot: () => untracked(() => source.get()),
    }),
    [source],
  );
  const value = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  useDebugValue(value);
  return value;
}

export interface CommandHandle<A extends unknown[], T> {
  /** Start it; await the returned promise if the caller needs the answer. */
  start: (...args: A) => Promise<T>;
  pending: boolean;
  error: unknown;
  result: T | undefined;
  state: CommandState<T>;
  reset: () => void;
}

/** Hand a command to the tree: one function to start, plus its observable state. */
export function useCommand<A extends unknown[], T>(cmd: Command<A, T>): CommandHandle<A, T> {
  const state = useCell(cmd.state);
  // The identity of start must not change across renders: it goes into handlers and deps.
  const ref = useRef(cmd);
  ref.current = cmd;
  const start = useCallback((...args: A) => ref.current.run(...args), []);
  const reset = useCallback(() => ref.current.reset(), []);
  return {
    start,
    reset,
    state,
    pending: state.kind === "running",
    error: state.kind === "failed" ? state.error : undefined,
    result: state.kind === "done" ? state.value : undefined,
  };
}

/**
 * Read a source, stating how fresh this screen needs it. Mounting is the
 * requirement; unmounting withdraws it, and a source nobody needs goes quiet.
 */
export function useSource<T>(feed: Source<T>, options: { within?: number } = {}): Remote<T> {
  const { within } = options;
  const view = useMemo(
    () => (within === undefined ? feed.state : fresh(feed, within)),
    [feed, within],
  );
  return useCell(view);
}
