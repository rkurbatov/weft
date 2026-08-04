// The same questions store.test.ts asks the hand-written sheet, asked of this
// one. If both files pass, the demos differ in how they are written, not in
// what they do. The last two tests are about the difference itself.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subscribe } from '#weft'
import { createSheet } from './sheet.ts'
import { sampleSheet, key } from '../common/sample.ts'
import { until } from '../../test/kit/index.ts'

function small() {
  return createSheet(
    new Map([
      ['A1', '1'],
      ['A2', '2'],
      ['A3', '=A1 + A2'],
      ['B1', '=A3 * 10'],
      ['C1', '=SUM(A1:A3)'],
    ]),
  )
}

/** Watch the cells a screen would be showing. */
/** Watch a handful of cells and record which of them were told about. */
function watching(sheet: ReturnType<typeof createSheet>, cells: string[], told: string[]): void {
  for (const at of cells) until(subscribe(sheet.shown(at), () => told.push(at)))
}

test('it works out what is asked for', () => {
  const sheet = small()
  assert.equal(sheet.shown('A3').peek(), '3')
  assert.equal(sheet.shown('B1').peek(), '30')
  assert.equal(sheet.shown('C1').peek(), '6')
})

test('a change travels as far as it has to and no further', () => {
  const sheet = small()
  const told: string[] = []
  watching(sheet, ['A1', 'A2', 'A3', 'B1', 'C1'], told)
  sheet.set('A1', '5')
  assert.equal(sheet.shown('A3').peek(), '7')
  assert.equal(sheet.shown('B1').peek(), '70')
  assert.equal(sheet.shown('C1').peek(), '14')
  assert.deepEqual(told.toSorted(), ['A1', 'A3', 'B1', 'C1'])
})

test('a change that alters nothing tells nobody', () => {
  const sheet = small()
  const told: string[] = []
  watching(sheet, ['B1'], told)
  sheet.set('A1', '1')
  assert.deepEqual(told, [])
})

test('editing a formula rewires what it depends on', () => {
  const sheet = small()
  sheet.set('B1', '=A2 * 10')
  assert.equal(sheet.shown('B1').peek(), '20')
  sheet.set('A1', '9')
  assert.equal(sheet.shown('B1').peek(), '20')
  sheet.set('A2', '3')
  assert.equal(sheet.shown('B1').peek(), '30')
})

test('a loop is named, not hung', () => {
  const sheet = small()
  sheet.set('A1', '=A3')
  assert.equal(sheet.shown('A1').peek(), '#CYCLE!')
  assert.equal(sheet.shown('A3').peek(), '#CYCLE!')
  sheet.set('A1', '4')
  assert.equal(sheet.shown('A1').peek(), '4')
  assert.equal(sheet.shown('A3').peek(), '6')
})

test('text and errors travel like values do', () => {
  const sheet = small()
  sheet.set('A2', 'note')
  assert.equal(sheet.shown('A3').peek(), '1')
  sheet.set('A2', '=1/0')
  assert.equal(sheet.shown('A2').peek(), '#DIV/0!')
  assert.equal(sheet.shown('A3').peek(), '#DIV/0!')
})

test('the sample sheet adds up', () => {
  const shape = { rows: 200, cols: 26 }
  const sheet = createSheet(sampleSheet(shape))
  const rows = shape.rows - 1
  assert.equal(sheet.shown(key(shape.rows - 1, 0)).peek(), String((rows * (rows + 1)) / 2))
  assert.equal(sheet.shown('D2').peek(), '12')
  assert.equal(sheet.shown('L4').peek(), '2')
})

test('nothing is worked out until somebody looks', () => {
  const shape = { rows: 200, cols: 26 }
  const sheet = createSheet(sampleSheet(shape))
  assert.equal(sheet.recomputes(), 0)
  sheet.shown('D2').peek()
  // Only D2 and the three cells it leans on.
  assert.ok(sheet.recomputes() <= 6, `worked out ${sheet.recomputes()} cells`)
})

test('an edit costs what is on screen, not what is in the sheet', () => {
  const shape = { rows: 200, cols: 26 }
  const sheet = createSheet(sampleSheet(shape))
  const told: string[] = []
  // A screen showing the first two rows.
  const shownCells: string[] = []
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < shape.cols; col++) shownCells.push(key(row, col))
  }
  watching(sheet, shownCells, told)
  sheet.resetRecomputes()
  sheet.set('A1', '2')
  // The hand-written sheet recomputes every dependant in the book — over two
  // hundred of them. Here the bill is the visible rows and what they lean on.
  assert.ok(sheet.recomputes() < 60, `worked out ${sheet.recomputes()} cells`)
  assert.ok(told.length > 0)
  assert.ok(told.every(at => shownCells.includes(at)))
})
