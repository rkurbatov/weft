// The same sheet on weft.
//
// Three families, and that is the whole file: the text of a cell, what that
// text means, and what the screen shows. Nothing here says who reads whom —
// reading is what records it.

import { batch, family, input, untracked } from "#weft";
import type { Cell, Input } from "#weft";
import { refName } from "../common/address.ts";
import { blockFolds } from "./blocks.ts";
import { plan, run, same, show } from "../common/formula.ts";
import type { Value } from "../common/formula.ts";
import type { Contents } from "../common/sample.ts";
import type { Ref } from "../common/address.ts";

const LOOP: Value = { error: "#CYCLE!" };

export interface SheetOptions {
  /** Answer long single-column totals from a tree of partial sums. On by default. */
  blocks?: boolean;
}

export interface Sheet {
  text(at: string): string;
  value(at: string): Value;
  shown(at: string): Cell<string>;
  set(at: string, text: string): void;
  edit(changes: Iterable<[string, string]>): void;
  recomputes(): number;
  resetRecomputes(): void;
}

export function createSheet(initial: Contents, options: SheetOptions = {}): Sheet {
  const texts = new Map<string, Input<string>>();
  let recomputed = 0;

  /** The text of a cell: stored, written only by the editor. */
  function text(at: string): Input<string> {
    const box = texts.get(at) ?? input("", { name: at });
    texts.set(at, box);
    return box;
  }

  /** What the text means. Reparsed when the text changes, and only then. */
  const meaning = family((at: string) => plan(text(at).get()), { name: "plan", max: 500_000 });

  const folds = (options.blocks ?? true) ? blockFolds((ref) => valueAt(refName(ref))) : undefined;

  /** The value. Reading a neighbour here is what makes this cell depend on it. */
  const value = family(
    (at: string): Value => {
      recomputed++;
      const lookup = { value: (ref: Ref) => valueAt(refName(ref)) };
      return run(meaning(at).get(), folds === undefined ? lookup : { ...lookup, fold: folds.fold });
    },
    // Equality by value, not by identity: a complaint is a fresh object each
    // time, and without this every recomputation would look like a change.
    { name: "value", max: 500_000, equal: same },
  );

  /**
   * A loop needs no search: reading a cell that is already computing throws, and
   * that is the whole of loop detection here.
   */
  function valueAt(at: string): Value {
    try {
      return value(at).get();
    } catch {
      return LOOP;
    }
  }

  /** What the screen shows. A cell of its own, so an unchanged look wakes nobody. */
  const shown = family((at: string) => show(valueAt(at)), { name: "shown", max: 500_000 });

  for (const [at, initialText] of initial) text(at).set(initialText);

  return {
    text: (at) => untracked(() => text(at).peek()),
    value: (at) => untracked(() => valueAt(at)),
    shown: (at) => shown(at),

    set(at, next) {
      text(at).set(next);
    },

    /** Several edits, one settling. */
    edit(changes) {
      batch(() => {
        for (const [at, next] of changes) text(at).set(next);
      });
    },

    recomputes: () => recomputed + (folds?.worked() ?? 0),
    resetRecomputes: () => {
      recomputed = 0;
      folds?.resetWorked();
    },
  };
}
