// Binding the hand-written store to React: a context to reach it, and a
// per-cell subscription so that a change redraws the cells it touched rather
// than the whole grid. None of this is free — it is the second layer the other
// demo does not have.

import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { Sheet } from "./store.ts";

const SheetContext = createContext<Sheet | null>(null);

export const SheetProvider = SheetContext.Provider;

export function useSheet(): Sheet {
  const sheet = useContext(SheetContext);
  if (sheet === null) throw new Error("no sheet above this component");
  return sheet;
}

/** What the cell shows. A string, so React can compare snapshots by value. */
export function useShown(at: string): string {
  const sheet = useSheet();
  const subscribe = useCallback(
    (onChange: () => void) => sheet.subscribe(at, onChange),
    [sheet, at],
  );
  const snapshot = useCallback(() => sheet.shown(at), [sheet, at]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
