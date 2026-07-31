// The sheet both demos load. Big on purpose: the point is what happens when a
// change lands in a sheet of tens of thousands of cells, not five.
//
// Depth is bounded deliberately. A running total leaning on the row above it all
// the way down would make one cell's value a chain a thousand deep, and that is
// a recursion problem rather than a spreadsheet one. Here the running total
// starts afresh every block, so depth stays short while width stays honest.

import { columnName } from './address.ts'

export interface SheetShape {
  readonly rows: number
  readonly cols: number
}

export const BLOCK = 100

export const SHEET: SheetShape = { rows: 1000, cols: 26 }

/** The contents of a sheet: what a person typed, cell by cell. */
export type Contents = Map<string, string>

export function key(row: number, col: number): string {
  return `${columnName(col)}${row + 1}`
}

/** ?rows=5000&cols=26 in the address bar, for trying a heavier sheet. */
export function shapeFromLocation(fallback: SheetShape = SHEET): SheetShape {
  if (typeof location === 'undefined') return fallback
  const asked = new URLSearchParams(location.search)
  const number = (name: string, was: number, most: number): number => {
    const raw = Number(asked.get(name))
    return Number.isFinite(raw) && raw > 1 ? Math.min(Math.floor(raw), most) : was
  }
  return { rows: number('rows', fallback.rows, 20_000), cols: number('cols', fallback.cols, 26) }
}

export function sampleSheet(shape: SheetShape = SHEET): Contents {
  const cells: Contents = new Map()
  const last = shape.rows - 1

  for (let row = 0; row < last; row++) {
    const n = row + 1 // the row as a spreadsheet writes it
    const put = (col: number, text: string): void => {
      if (col < shape.cols) cells.set(key(row, col), text)
    }

    put(0, String(n))
    put(1, `=A${n} * 2`)
    put(2, `=B${n} + A${n}`)
    put(3, `=SUM(A${n}:C${n})`)
    put(4, `=AVG(A${n}:C${n})`)
    // The running total of a block, so no chain runs deeper than BLOCK.
    put(5, row % BLOCK === 0 ? `=D${n}` : `=F${n - 1} + D${n}`)
    put(6, `=MIN(A${n}:E${n})`)
    put(7, `=MAX(A${n}:E${n})`)
    put(8, `=COUNT(A${n}:H${n})`)
    put(9, `=ABS(A${n} - ${Math.floor(shape.rows / 2)})`)
    put(10, `=ROUND(E${n}, 2)`)
    put(11, `=SQRT(A${n})`)
    put(12, `=MOD(A${n}, 7)`)
    put(13, `=INT(E${n})`)
    put(14, `=SIGN(J${n} - 10)`)
    put(15, `=POW(M${n}, 2)`)
    // The rest of the width is a chain across the row: each leans on the one before.
    for (let col = 16; col < shape.cols; col++) {
      put(col, `=${columnName(col - 1)}${n} + A${n}`)
    }
  }

  // The totals row: a column-wide sum each, plus a couple of spot checks.
  for (let col = 0; col < Math.min(shape.cols, 16); col++) {
    cells.set(key(last, col), `=SUM(${columnName(col)}1:${columnName(col)}${last})`)
  }
  if (shape.cols > 16) cells.set(key(last, 16), `=COUNT(A1:A${last})`)
  if (shape.cols > 17) cells.set(key(last, 17), `=MAX(A1:A${last})`)

  return cells
}

/** How many cells the sample fills, for the toolbar to show. */
export function sizeOf(shape: SheetShape): number {
  return shape.rows * shape.cols
}
