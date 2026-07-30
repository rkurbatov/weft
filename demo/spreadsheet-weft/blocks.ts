// Block folds.
//
// A total over a thousand cells does not have to read a thousand cells. Cut the
// column into blocks of SPAN, keep each block's partial answer in a cell of its
// own, and build blocks of blocks above them. Editing one cell then touches one
// block per level and the total — a handful of sums instead of the whole column.
//
// This is worth doing here and nowhere else: each partial is an ordinary cell,
// so what depends on what, and what has to be redone, is the graph's business.
// The hand-written sheet could keep the same tree, but would have to invalidate
// it by hand, level by level.

import { family } from "#weft";
import { asDec, counts, fail, isError } from "../common/formula.ts";
import type { FoldName, Value } from "../common/formula.ts";
import type { Ref } from "../common/address.ts";
import * as dec from "../common/dec.ts";

/** Cells per block. A level up covers SPAN times as much. */
export const SPAN = 32;

/** Below this a range is simply read: the tree would cost more than it saves. */
const WORTH_IT = SPAN;

export interface Folds {
  /** The answer for a rectangle, or undefined when this is not a case for blocks. */
  fold(name: FoldName, from: Ref, to: Ref): Value | undefined;
  /** How many partial answers were worked out since the last reset. */
  worked(): number;
  resetWorked(): void;
}

/** Empty means "nothing so far": MIN and MAX start from nothing, not from zero. */
function join(name: FoldName, a: Value, b: Value): Value {
  if (isError(a)) return a;
  if (isError(b)) return b;
  if (a === "") return b;
  if (b === "") return a;
  const left = asDec(a);
  const right = asDec(b);
  if (isError(left)) return left;
  if (isError(right)) return right;
  switch (name) {
    case "SUM":
    case "COUNT":
      return dec.add(left, right);
    case "PROD":
      return dec.mul(left, right);
    case "MIN":
      return dec.cmp(left, right) <= 0 ? left : right;
    case "MAX":
      return dec.cmp(left, right) >= 0 ? left : right;
  }
}

function start(name: FoldName): Value {
  if (name === "PROD") return dec.fromInt(1);
  if (name === "MIN" || name === "MAX") return "";
  return dec.ZERO;
}

/** One cell's contribution: the same rules the ordinary path uses. */
function contribution(name: FoldName, value: Value): Value {
  if (name === "COUNT") return counts(value) ? dec.fromInt(1) : dec.ZERO;
  const n = asDec(value);
  return isError(n) ? n : n;
}

export function blockFolds(valueAt: (ref: Ref) => Value): Folds {
  let worked = 0;

  /**
   * A block of a line. `down` means a column with rows running through it,
   * otherwise a row with columns running through it; `line` is the fixed one.
   * Level 0 covers cells, each level above covers SPAN blocks below.
   */
  const block = family(
    (id: string): Value => {
      worked++;
      const [name, side, line, level, index] = id.split("|") as [
        FoldName,
        string,
        string,
        string,
        string,
      ];
      const down = side === "d";
      const fixed = Number(line);
      const step = Number(level);
      const at = Number(index);

      let answer: Value = start(name);
      if (step === 0) {
        const first = at * SPAN;
        for (let along = first; along < first + SPAN; along++) {
          const ref = down ? { row: along, col: fixed } : { row: fixed, col: along };
          answer = join(name, answer, contribution(name, valueAt(ref)));
        }
        return answer;
      }
      const firstChild = at * SPAN;
      for (let child = firstChild; child < firstChild + SPAN; child++) {
        answer = join(name, answer, block(`${name}|${side}|${fixed}|${step - 1}|${child}`).get());
      }
      return answer;
    },
    { name: "block", max: 500_000 },
  );

  const covers = (level: number): number => SPAN ** (level + 1);

  /** One line of the rectangle, taken in the largest aligned blocks that fit. */
  function foldLine(name: FoldName, down: boolean, line: number, from: number, to: number): Value {
    const side = down ? "d" : "a";
    let answer: Value = start(name);
    let along = from;
    while (along <= to) {
      let level = -1;
      while (along % covers(level + 1) === 0 && along + covers(level + 1) - 1 <= to) level++;
      if (level >= 0) {
        answer = join(
          name,
          answer,
          block(`${name}|${side}|${line}|${level}|${along / covers(level)}`).get(),
        );
        along += covers(level);
      } else {
        const ref = down ? { row: along, col: line } : { row: line, col: along };
        answer = join(name, answer, contribution(name, valueAt(ref)));
        along++;
      }
    }
    return answer;
  }

  return {
    fold(name, from, to) {
      const firstRow = Math.min(from.row, to.row);
      const lastRow = Math.max(from.row, to.row);
      const firstCol = Math.min(from.col, to.col);
      const lastCol = Math.max(from.col, to.col);
      if (firstRow < 0 || firstCol < 0) return fail("#REF!");

      const height = lastRow - firstRow + 1;
      const width = lastCol - firstCol + 1;
      // Cut the rectangle into whichever lines are longer: the tree only pays
      // along the long side, and a short rectangle is not worth a tree at all.
      const down = height >= width;
      if ((down ? height : width) < WORTH_IT) return undefined;

      let answer: Value = start(name);
      if (down) {
        for (let col = firstCol; col <= lastCol; col++) {
          answer = join(name, answer, foldLine(name, true, col, firstRow, lastRow));
        }
      } else {
        for (let row = firstRow; row <= lastRow; row++) {
          answer = join(name, answer, foldLine(name, false, row, firstCol, lastCol));
        }
      }
      return answer;
    },

    worked: () => worked,
    resetWorked: () => {
      worked = 0;
    },
  };
}
