// The sheet both demos load, so the numbers compare. Column A holds numbers,
// B and C are chains of formulas, D sums a row's worth, and the last row totals
// everything — a long dependency chain on purpose.

import { columnName } from './address.ts'

export interface SheetShape {
    readonly rows: number
    readonly cols: number
}

export const SHEET: SheetShape = { rows: 200, cols: 12 }

export type Sheet = Map<string, string>

export function key(row: number, col: number): string {
    return `${columnName(col)}${row + 1}`
}

export function sampleSheet(shape: SheetShape = SHEET): Sheet {
    const cells: Sheet = new Map()
    const last = shape.rows - 1

    for (let row = 0; row < last; row++) {
        const n = row + 1
        cells.set(key(row, 0), String(n))
        cells.set(key(row, 1), `=A${n} * 2`)
        cells.set(key(row, 2), `=B${n} + A${n}`)
        cells.set(key(row, 3), `=SUM(A${n}:C${n})`)
        cells.set(key(row, 4), `=AVG(A${n}:D${n})`)
        // A running total: every row leans on the row above it.
        cells.set(key(row, 5), row === 0 ? '=D1' : `=F${n - 1} + D${n}`)
    }

    // The totals row: one cell per column over everything above it.
    for (let col = 0; col < 6; col++) {
        cells.set(key(last, col), `=SUM(${columnName(col)}1:${columnName(col)}${last})`)
    }
    cells.set(key(last, 6), `=PROD(A1:A5)`)

    return cells
}