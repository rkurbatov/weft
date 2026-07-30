// The hand-written sheet.
//
// Reading order: what is stored, then the two indexes that have to be kept in
// step, then the four steps of an edit — relink, spread, sort, recompute.

import { refName } from "../common/address.ts";
import { read, show } from "../common/formula.ts";
import type { Value } from "../common/formula.ts";
import type { Contents } from "../common/sample.ts";
import { refsOf } from "./depends.ts";

export interface Sheet {
  text(at: string): string;
  value(at: string): Value;
  shown(at: string): string;
  set(at: string, text: string): void;
  subscribe(at: string, listener: () => void): () => void;
  recomputes(): number;
  resetRecomputes(): void;
}

const LOOP = show({ error: "#CYCLE!" });

export function createSheet(initial: Contents): Sheet {
  const text = new Map<string, string>(initial);
  const value = new Map<string, Value>();
  const shown = new Map<string, string>();

  // The dependency graph, both ways round. Two maps that must agree, kept in
  // agreement by hand on every edit.
  const uses = new Map<string, string[]>(); // cell -> cells it reads
  const usedBy = new Map<string, Set<string>>(); // cell -> cells that read it

  const listeners = new Map<string, Set<() => void>>();
  let recomputed = 0;

  // -- the two indexes -----------------------------------------------------

  function relink(at: string): void {
    for (const old of uses.get(at) ?? []) usedBy.get(old)?.delete(at);
    const now = refsOf(text.get(at) ?? "").map(refName);
    uses.set(at, now);
    for (const ref of now) {
      const readers = usedBy.get(ref) ?? new Set();
      readers.add(at);
      usedBy.set(ref, readers);
    }
  }

  // -- the four steps of an edit -------------------------------------------

  /** 1. Everything that leans on this cell, however far away. */
  function spread(from: string): Set<string> {
    const touched = new Set([from]);
    const queue = [from];
    while (queue.length > 0) {
      for (const reader of usedBy.get(queue.pop() as string) ?? []) {
        if (touched.has(reader)) continue;
        touched.add(reader);
        queue.push(reader);
      }
    }
    return touched;
  }

  /** 2. An order in which they may be recomputed. Whatever has no place is in a loop. */
  function sort(touched: Set<string>): { order: string[]; looped: string[] } {
    const waiting = new Map<string, number>();
    for (const at of touched) {
      waiting.set(at, (uses.get(at) ?? []).filter((ref) => touched.has(ref)).length);
    }

    const order = [...touched].filter((at) => waiting.get(at) === 0);
    const placed = new Set(order);
    for (let i = 0; i < order.length; i++) {
      for (const reader of usedBy.get(order[i] as string) ?? []) {
        if (!touched.has(reader)) continue;
        const left = (waiting.get(reader) as number) - 1;
        waiting.set(reader, left);
        if (left === 0) {
          order.push(reader);
          placed.add(reader);
        }
      }
    }

    return { order, looped: [...touched].filter((at) => !placed.has(at)) };
  }

  /** 3. Work one cell out. True when what it shows has changed. */
  function recompute(at: string): boolean {
    recomputed++;
    const now = read(text.get(at) ?? "", { value: (ref) => value.get(refName(ref)) ?? "" });
    value.set(at, now);
    return replace(at, show(now));
  }

  function replace(at: string, look: string): boolean {
    if (shown.get(at) === look) return false;
    shown.set(at, look);
    return true;
  }

  /** 4. Tell the cells whose look changed — and only those. */
  function tell(at: string): void {
    for (const listener of listeners.get(at) ?? []) listener();
  }

  function settle(touched: Set<string>): void {
    const { order, looped } = sort(touched);
    for (const at of looped) {
      value.set(at, { error: "#CYCLE!" });
      if (replace(at, LOOP)) tell(at);
    }
    for (const at of order) {
      if (recompute(at)) tell(at);
    }
  }

  // The sheet as loaded: link everything, then work all of it out.
  for (const at of text.keys()) relink(at);
  settle(new Set(text.keys()));

  return {
    text: (at) => text.get(at) ?? "",
    value: (at) => value.get(at) ?? "",
    shown: (at) => shown.get(at) ?? "",

    set(at, next) {
      text.set(at, next);
      relink(at);
      settle(spread(at));
    },

    subscribe(at, listener) {
      const set = listeners.get(at) ?? new Set();
      set.add(listener);
      listeners.set(at, set);
      return () => set.delete(listener);
    },

    recomputes: () => recomputed,
    resetRecomputes: () => {
      recomputed = 0;
    },
  };
}
