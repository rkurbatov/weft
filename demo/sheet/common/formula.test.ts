import { test } from 'node:test'
import assert from 'node:assert/strict'
import { columnName, columnNumber, parseRef, refName, spanRefs } from './address.ts'
import { read, parse, evaluate, show, isError } from './formula.ts'
import * as dec from './dec.ts'
import type { Dec } from './dec.ts'
import type { CellError, Lookup, Value } from './formula.ts'
import type { Ref } from './address.ts'
import { sampleSheet, key } from './sample.ts'

/** A sheet of literal cells: numbers written as text, like a person types them. */
function sheetOf(cells: Record<string, string | CellError>): Lookup {
  return {
    value: (ref: Ref) => {
      const raw = cells[refName(ref)]
      if (raw === undefined) return ''
      return typeof raw === 'string' ? (dec.fromText(raw) ?? raw) : raw
    },
  }
}

/** What a formula shows, which is what a person compares. */
function shownAs(text: string, cells: Lookup): string {
  return show(read(text, cells))
}

test('columns count the way spreadsheets count', () => {
  assert.equal(columnName(0), 'A')
  assert.equal(columnName(25), 'Z')
  assert.equal(columnName(26), 'AA')
  assert.equal(columnNumber('A'), 0)
  assert.equal(columnNumber('AA'), 26)
  assert.deepEqual(parseRef('B3'), { row: 2, col: 1 })
  assert.equal(refName({ row: 2, col: 1 }), 'B3')
  assert.equal(parseRef('hello'), undefined)
})

test('a span covers the rectangle, whichever corner you give first', () => {
  const refs = spanRefs({ row: 2, col: 1 }, { row: 0, col: 0 })
  assert.deepEqual(refs.map(refName), ['A1', 'B1', 'A2', 'B2', 'A3', 'B3'])
})

test('arithmetic, with the usual precedence', () => {
  const empty = sheetOf({})
  assert.equal(shownAs('=1 + 2 * 3', empty), '7')
  assert.equal(shownAs('=(1 + 2) * 3', empty), '9')
  assert.equal(shownAs('=2 ^ 3 ^ 2', empty), '512') // right to left
  assert.equal(shownAs('=-4 + 1', empty), '-3')
  assert.equal(shownAs('=10 / 4', empty), '2.5')
})

test('a plain cell is a number if it looks like one, otherwise words', () => {
  const empty = sheetOf({})
  assert.equal(shownAs('42', empty), '42')
  assert.equal(shownAs('  7.5 ', empty), '7.5')
  assert.equal(shownAs('total', empty), 'total')
  assert.equal(shownAs('', empty), '')
})

test('references and ranges', () => {
  const cells = sheetOf({ A1: '1', A2: '2', A3: '3', B1: '10' })
  assert.equal(shownAs('=A2', cells), '2')
  assert.equal(shownAs('=A1 + B1', cells), '11')
  assert.equal(shownAs('=SUM(A1:A3)', cells), '6')
  assert.equal(shownAs('=PROD(A1:A3)', cells), '6')
  assert.equal(shownAs('=AVG(A1:A3)', cells), '2')
  assert.equal(shownAs('=SUM(A1:A3, B1, 4)', cells), '20')
})

test('empty and wordy cells count as zero', () => {
  const cells = sheetOf({ A1: '1', A2: '', A3: 'note' })
  assert.equal(shownAs('=SUM(A1:A3)', cells), '1')
  assert.equal(shownAs('=A3 + 1', cells), '1')
})

test('errors travel outward, and division by zero is one', () => {
  const cells = sheetOf({ A1: { error: '#CYCLE!' }, A2: '5' })
  assert.deepEqual(read('=A1 + A2', cells), { error: '#CYCLE!' })
  assert.deepEqual(read('=SUM(A1:A2)', cells), { error: '#CYCLE!' })
  assert.deepEqual(read('=1/0', cells), { error: '#DIV/0!' })
  assert.deepEqual(read('=NOPE(1)', cells), { error: '#NAME?' })
  assert.deepEqual(read('=1 +', cells), { error: '#SYNTAX!' })
  assert.deepEqual(read('=(1', cells), { error: '#SYNTAX!' })
})

test('shown text is short and errors show their code', () => {
  assert.equal(show(dec.fromInt(3)), '3')
  assert.equal(show(dec.div(dec.fromInt(1), dec.fromInt(3)) as Dec), '0.333333')
  assert.equal(show('note'), 'note')
  assert.equal(show({ error: '#REF!' }), '#REF!')
})

test('the wider set of functions', () => {
  const cells = sheetOf({ A1: '4', A2: '9', A3: 'note', A4: '', B1: '-3' })
  assert.equal(shownAs('=MIN(A1:A2)', cells), '4')
  assert.equal(shownAs('=MAX(A1:A2, 100)', cells), '100')
  assert.equal(shownAs('=COUNT(A1:A4)', cells), '2') // words and blanks do not count
  assert.equal(shownAs('=ABS(B1)', cells), '3')
  assert.equal(shownAs('=SQRT(A2)', cells), '3')
  assert.equal(shownAs('=MOD(A2, 4)', cells), '1')
  assert.equal(shownAs('=POW(A1, 3)', cells), '64')
  assert.equal(shownAs('=INT(10 / 3)', cells), '3')
  assert.equal(shownAs('=SIGN(B1)', cells), '-1')
  assert.equal(shownAs('=ROUND(10 / 3, 2)', cells), '3.33')
  assert.equal(shownAs('=ROUND(10 / 3)', cells), '3')
})

test('a function given the wrong number of things says so', () => {
  const empty = sheetOf({})
  assert.deepEqual(read('=SQRT(1, 2)', empty), { error: '#VALUE!' })
  assert.deepEqual(read('=SQRT(-1)', empty), { error: '#VALUE!' })
  assert.deepEqual(read('=MOD(1)', empty), { error: '#VALUE!' })
  assert.deepEqual(read('=MOD(1, 0)', empty), { error: '#DIV/0!' })
})

test('the sample sheet is a real chain, and it adds up', () => {
  const shape = { rows: 40, cols: 26 }
  const cells = sampleSheet(shape)
  assert.equal(cells.get('A1'), '1')
  assert.equal(cells.get('B1'), '=A1 * 2')
  assert.equal(cells.get('F2'), '=F1 + D2')
  assert.equal(cells.get('Z1'), '=Y1 + A1')
  assert.equal(cells.get(key(shape.rows - 1, 0)), `=SUM(A1:A${shape.rows - 1})`)

  // Work the whole sheet out by hand, the slow way, and check a few answers.
  const values = new Map<string, Value>()
  const resolve = (at: string): Value => {
    const known = values.get(at)
    if (known !== undefined) return known
    values.set(at, { error: '#CYCLE!' })
    const value = read(cells.get(at) ?? '', { value: ref => resolve(refName(ref)) })
    values.set(at, value)
    return value
  }
  assert.equal(show(resolve('D1')), '6')
  assert.equal(show(resolve('D2')), '12')
  assert.equal(show(resolve('F2')), '18')
  assert.equal(show(resolve('L4')), '2') // SQRT(4)
  assert.equal(show(resolve('M9')), '2') // 9 mod 7
  const rows = shape.rows - 1
  const total = resolve(key(shape.rows - 1, 0))
  assert.equal(show(total), String((rows * (rows + 1)) / 2))
  assert.equal(isError(total), false)
})

test("a cycle is the host's business, not the parser's", () => {
  // The engine simply asks; whoever answers decides what a loop means.
  const seen: string[] = []
  const lookup: Lookup = {
    value: ref => {
      seen.push(refName(ref))
      return { error: '#CYCLE!' }
    },
  }
  assert.deepEqual(evaluate(parse('A1 + A1'), lookup), { error: '#CYCLE!' })
  assert.deepEqual(seen, ['A1'])
})
