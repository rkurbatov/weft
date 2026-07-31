// Blocks must not change a single answer — only the price of getting it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subscribe } from '#weft'
import { createSheet } from './sheet.ts'
import { SPAN } from './blocks.ts'
import { columnName } from '../common/address.ts'
import type { Contents } from '../common/sample.ts'

/** A column of numbers, plus whatever else the test wants. */
function column(rows: number, extra: Array<[string, string]> = []): Contents {
  const cells: Contents = new Map()
  for (let row = 0; row < rows; row++) cells.set(`A${row + 1}`, String(row + 1))
  for (const [at, text] of extra) cells.set(at, text)
  return cells
}

function bothWays(cells: Contents, at: string): { blocks: string; plain: string } {
  const withBlocks = createSheet(cells)
  const withoutBlocks = createSheet(cells, { blocks: false })
  return { blocks: withBlocks.shown(at).peek(), plain: withoutBlocks.shown(at).peek() }
}

test('a long total is the same number, blocks or no blocks', () => {
  const rows = 1000
  const cells = column(rows, [['C1', `=SUM(A1:A${rows})`]])
  const { blocks, plain } = bothWays(cells, 'C1')
  assert.equal(blocks, String((rows * (rows + 1)) / 2))
  assert.equal(blocks, plain)
})

test('fractions too — this is why the arithmetic had to be exact first', () => {
  const rows = 500
  const cells: Contents = new Map()
  for (let row = 0; row < rows; row++) cells.set(`A${row + 1}`, `${row}.001`)
  cells.set('C1', `=SUM(A1:A${rows})`)
  const { blocks, plain } = bothWays(cells, 'C1')
  assert.equal(blocks, plain) // to the last digit, not merely close
  assert.equal(blocks, '124750.5')
})

test('the other folds agree as well', () => {
  const rows = 300
  const cells = column(rows, [
    ['C1', `=MIN(A1:A${rows})`],
    ['C2', `=MAX(A1:A${rows})`],
    ['C3', `=COUNT(A1:A${rows})`],
    ['C4', `=AVG(A1:A${rows})`],
  ])
  for (const at of ['C1', 'C2', 'C3', 'C4']) {
    const { blocks, plain } = bothWays(cells, at)
    assert.equal(blocks, plain, `${at} disagrees`)
  }
})

test('words and blanks are treated exactly as before', () => {
  const rows = 200
  const cells = column(rows, [
    ['A5', 'note'],
    ['A6', ''],
    ['C1', `=SUM(A1:A${rows})`],
    ['C2', `=COUNT(A1:A${rows})`],
    ['C3', `=MIN(A1:A${rows})`],
  ])
  for (const at of ['C1', 'C2', 'C3']) {
    const { blocks, plain } = bothWays(cells, at)
    assert.equal(blocks, plain, `${at} disagrees`)
  }
})

test('a complaint inside the range still comes out', () => {
  const rows = 100
  const cells = column(rows, [
    ['A7', '=1/0'],
    ['C1', `=SUM(A1:A${rows})`],
  ])
  const { blocks, plain } = bothWays(cells, 'C1')
  assert.equal(blocks, '#DIV/0!')
  assert.equal(blocks, plain)
})

test('a short range is read the ordinary way', () => {
  const cells = column(10, [['C1', '=SUM(A1:A10)']])
  const sheet = createSheet(cells)
  assert.equal(sheet.shown('C1').peek(), '55')
})

test('an edit costs a handful of partials, not the whole column', () => {
  const rows = 4096 // four levels of blocks at SPAN = 32
  const cells = column(rows, [['C1', `=SUM(A1:A${rows})`]])
  const sheet = createSheet(cells)
  const stop = subscribe(sheet.shown('C1'), () => {})

  sheet.resetRecomputes()
  sheet.set('A1', '1000')
  const withBlocks = sheet.recomputes()
  assert.equal(sheet.shown('C1').peek(), String((rows * (rows + 1)) / 2 + 999))
  stop()

  const plainSheet = createSheet(cells, { blocks: false })
  const stopPlain = subscribe(plainSheet.shown('C1'), () => {})
  plainSheet.resetRecomputes()
  plainSheet.set('A1', '1000')
  const withoutBlocks = plainSheet.recomputes()
  stopPlain()

  // Reading the column outright is one recomputation of a formula that touches
  // 4096 cells; through blocks it is a few dozen small ones.
  assert.ok(withBlocks < 20, `blocks worked out ${withBlocks} partials`)
  assert.ok(withoutBlocks <= 3, `plain worked out ${withoutBlocks}`)
})

test('the tree keeps up with edits anywhere in the column', () => {
  const rows = 2048
  const cells = column(rows, [['C1', `=SUM(A1:A${rows})`]])
  const sheet = createSheet(cells)
  const stop = subscribe(sheet.shown('C1'), () => {})
  let expected = (rows * (rows + 1)) / 2

  for (const row of [1, 33, 512, 1025, rows]) {
    const was = row
    sheet.set(`A${row}`, '0')
    expected -= was
    assert.equal(sheet.shown('C1').peek(), String(expected), `after A${row}`)
  }
  stop()
})

test('a short row range is read the ordinary way, and still adds up', () => {
  const cells: Contents = new Map()
  for (let col = 0; col < 26; col++) cells.set(`${columnName(col)}1`, String(col + 1))
  cells.set('A3', '=SUM(A1:Z1)')
  const sheet = createSheet(cells)
  assert.equal(sheet.shown('A3').peek(), '351')
  assert.ok(SPAN > 1)
})

/** A wide sheet: one row, many columns. */
function wide(cols: number, extra: Array<[string, string]> = []): Contents {
  const cells: Contents = new Map()
  for (let col = 0; col < cols; col++) cells.set(`${columnName(col)}1`, String(col + 1))
  for (const [at, text] of extra) cells.set(at, text)
  return cells
}

test('a long row folds through blocks too, and agrees with plain reading', () => {
  const cols = 400 // well past SPAN, so the tree is used
  const last = columnName(cols - 1)
  const cells = wide(cols, [
    ['A3', `=SUM(A1:${last}1)`],
    ['A4', `=MAX(A1:${last}1)`],
  ])
  for (const at of ['A3', 'A4']) {
    const { blocks, plain } = bothWays(cells, at)
    assert.equal(blocks, plain, `${at} disagrees`)
  }
  assert.equal(bothWays(cells, 'A3').blocks, String((cols * (cols + 1)) / 2))
})

test('an edit in a long row costs a handful of partials', () => {
  const cols = 1024
  const last = columnName(cols - 1)
  const cells = wide(cols, [['A3', `=SUM(A1:${last}1)`]])
  const sheet = createSheet(cells)
  const stop = subscribe(sheet.shown('A3'), () => {})
  sheet.resetRecomputes()
  sheet.set('B1', '1000')
  assert.equal(sheet.shown('A3').peek(), String((cols * (cols + 1)) / 2 + 998))
  assert.ok(sheet.recomputes() < 20, `worked out ${sheet.recomputes()} partials`)
  stop()
})

test('a rectangle is cut along its longer side', () => {
  const rows = 300
  const cols = 8
  const cells: Contents = new Map()
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) cells.set(`${columnName(c)}${r + 1}`, String(r + c))
  }
  const corner = `${columnName(cols - 1)}${rows}`
  cells.set('J1', `=SUM(A1:${corner})`)
  cells.set('J2', `=MIN(A1:${corner})`)
  cells.set('J3', `=COUNT(A1:${corner})`)
  for (const at of ['J1', 'J2', 'J3']) {
    const { blocks, plain } = bothWays(cells, at)
    assert.equal(blocks, plain, `${at} disagrees`)
  }
})

test('a wide rectangle agrees as well', () => {
  const rows = 6
  const cols = 200
  const cells: Contents = new Map()
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) cells.set(`${columnName(c)}${r + 1}`, String(r * 2 + c))
  }
  cells.set('A20', `=SUM(A1:${columnName(cols - 1)}${rows})`)
  const { blocks, plain } = bothWays(cells, 'A20')
  assert.equal(blocks, plain)
})
