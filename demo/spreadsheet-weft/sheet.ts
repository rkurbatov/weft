// The same sheet on weft.
//
// Three families, and that is the whole file: the text of a cell, what that
// text means, and what the screen shows. Nothing here says who reads whom —
// reading is what records it.

import { batch, blocks, family, input, untracked } from '#weft'
import type { Blocks, Cell, Input } from '#weft'
import { refName } from '../common/address.ts'
import { fail, foldJoin, foldOne, foldZero, plan, run, same, show } from '../common/formula.ts'
import type { FoldName, Value } from '../common/formula.ts'
import type { Contents } from '../common/sample.ts'
import type { Ref } from '../common/address.ts'

const LOOP: Value = { error: '#CYCLE!' }

export interface SheetOptions {
  /** Answer long single-column totals from a tree of partial sums. On by default. */
  blocks?: boolean
}

export interface Sheet {
  text(at: string): string
  value(at: string): Value
  shown(at: string): Cell<string>
  set(at: string, text: string): void
  edit(changes: Iterable<[string, string]>): void
  recomputes(): number
  resetRecomputes(): void
}

export function createSheet(initial: Contents, options: SheetOptions = {}): Sheet {
  const texts = new Map<string, Input<string>>()
  let recomputed = 0

  /** The text of a cell: stored, written only by the editor. */
  function text(at: string): Input<string> {
    const box = texts.get(at) ?? input('', { name: at })
    texts.set(at, box)
    return box
  }

  /** What the text means. Reparsed when the text changes, and only then. */
  const meaning = family((at: string) => plan(text(at).get()), { name: 'plan', max: 500_000 })

  // A tree of partial answers per fold and direction: 'SUM|d|3' is column 3
  // summed downwards. Under this many cells a range is simply read — the tree
  // would cost more than it saves.
  const WORTH_IT = 32
  const trees = new Map<FoldName, { down: Blocks<Value>; across: Blocks<Value> }>()
  const treesFor = (name: FoldName): { down: Blocks<Value>; across: Blocks<Value> } => {
    let pair = trees.get(name)
    if (pair === undefined) {
      const of = (down: boolean): Blocks<Value> =>
        blocks<Value>({
          name: `fold.${name}.${down ? 'down' : 'across'}`,
          zero: foldZero(name),
          join: (a, b) => foldJoin(name, a, b),
          read: (line, at) =>
            foldOne(
              name,
              valueAt(
                refName(down ? { row: at, col: Number(line) } : { row: Number(line), col: at }),
              ),
            ),
          max: 500_000,
        })
      pair = { down: of(true), across: of(false) }
      trees.set(name, pair)
    }
    return pair
  }

  /** A rectangle, cut into lines along its longer side — the side a tree pays on. */
  const fold = (name: FoldName, from: Ref, to: Ref): Value | undefined => {
    const firstRow = Math.min(from.row, to.row)
    const lastRow = Math.max(from.row, to.row)
    const firstCol = Math.min(from.col, to.col)
    const lastCol = Math.max(from.col, to.col)
    if (firstRow < 0 || firstCol < 0) return fail('#REF!')

    const down = lastRow - firstRow >= lastCol - firstCol
    const long = down ? lastRow - firstRow + 1 : lastCol - firstCol + 1
    if (long < WORTH_IT) return undefined

    const tree = down ? treesFor(name).down : treesFor(name).across
    let answer = foldZero(name)
    if (down) {
      for (let col = firstCol; col <= lastCol; col++) {
        answer = foldJoin(name, answer, tree.range(String(col), firstRow, lastRow))
      }
    } else {
      for (let row = firstRow; row <= lastRow; row++) {
        answer = foldJoin(name, answer, tree.range(String(row), firstCol, lastCol))
      }
    }
    return answer
  }

  const useBlocks = options.blocks ?? true
  const worked = (): number => {
    let sum = 0
    for (const pair of trees.values()) sum += pair.down.worked() + pair.across.worked()
    return sum
  }

  /** The value. Reading a neighbour here is what makes this cell depend on it. */
  const value = family(
    (at: string): Value => {
      recomputed++
      const lookup = { value: (ref: Ref) => valueAt(refName(ref)) }
      return run(meaning(at).get(), useBlocks ? { ...lookup, fold } : lookup)
    },
    // Equality by value, not by identity: a complaint is a fresh object each
    // time, and without this every recomputation would look like a change.
    { name: 'value', max: 500_000, equal: same },
  )

  /**
   * A loop needs no search: reading a cell that is already computing throws, and
   * that is the whole of loop detection here.
   */
  function valueAt(at: string): Value {
    try {
      return value(at).get()
    } catch {
      return LOOP
    }
  }

  /** What the screen shows. A cell of its own, so an unchanged look wakes nobody. */
  const shown = family((at: string) => show(valueAt(at)), { name: 'shown', max: 500_000 })

  for (const [at, initialText] of initial) text(at).set(initialText)

  return {
    text: at => untracked(() => text(at).peek()),
    value: at => untracked(() => valueAt(at)),
    shown: at => shown(at),

    set(at, next) {
      text(at).set(next)
    },

    /** Several edits, one settling. */
    edit(changes) {
      batch(() => {
        for (const [at, next] of changes) text(at).set(next)
      })
    },

    recomputes: () => recomputed + worked(),
    resetRecomputes: () => {
      recomputed = 0
      for (const pair of trees.values()) {
        pair.down.resetWorked()
        pair.across.resetWorked()
      }
    },
  }
}
