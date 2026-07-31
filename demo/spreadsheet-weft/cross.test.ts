// The two sheets held against each other: whatever one shows, the other must
// show too — every cell, before and after edits.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSheet as classic } from '../spreadsheet/store.ts'
import { createSheet as onWeft } from './sheet.ts'
import { sampleSheet, key } from '../common/sample.ts'

test('both sheets show the same thing in every cell', () => {
  const shape = { rows: 300, cols: 26 }
  const cells = sampleSheet(shape)
  const left = classic(cells)
  const right = onWeft(cells)
  let checked = 0
  for (let row = 0; row < shape.rows; row++) {
    for (let col = 0; col < shape.cols; col++) {
      const at = key(row, col)
      assert.equal(right.shown(at).peek(), left.shown(at), `${at} disagrees`)
      checked++
    }
  }
  assert.equal(checked, shape.rows * shape.cols)
})

test('and they still agree after a few edits', () => {
  const shape = { rows: 200, cols: 26 }
  const cells = sampleSheet(shape)
  const left = classic(cells)
  const right = onWeft(cells)
  for (const [at, text] of [
    ['A1', '100'],
    ['A50', '-3.5'],
    ['A199', 'note'],
    ['B2', '=A2 * 3'],
  ] as const) {
    left.set(at, text)
    right.set(at, text)
  }
  for (let row = 0; row < shape.rows; row++) {
    for (let col = 0; col < shape.cols; col++) {
      const at = key(row, col)
      assert.equal(right.shown(at).peek(), left.shown(at), `${at} disagrees`)
    }
  }
})
