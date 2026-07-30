import { test } from 'node:test'
import assert from 'node:assert/strict'
import { columnName, columnNumber, parseRef, refName, spanRefs } from './address.ts'
import { read, parse, evaluate, referencesOfText, show, isError } from './formula.ts'
import type { Lookup, Value } from './formula.ts'
import type { Ref } from './address.ts'
import { sampleSheet, SHEET, key } from './sheet.ts'

function sheetOf(cells: Record<string, Value>): Lookup {
    return {
        value: (ref: Ref) => cells[refName(ref)] ?? '',
    }
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
    assert.equal(read('=1 + 2 * 3', empty), 7)
    assert.equal(read('=(1 + 2) * 3', empty), 9)
    assert.equal(read('=2 ^ 3 ^ 2', empty), 512) // right to left
    assert.equal(read('=-4 + 1', empty), -3)
    assert.equal(read('=10 / 4', empty), 2.5)
})

test('a plain cell is a number if it looks like one, otherwise words', () => {
    const empty = sheetOf({})
    assert.equal(read('42', empty), 42)
    assert.equal(read('  7.5 ', empty), 7.5)
    assert.equal(read('total', empty), 'total')
    assert.equal(read('', empty), '')
})

test('references and ranges', () => {
    const cells = sheetOf({ A1: 1, A2: 2, A3: 3, B1: 10 })
    assert.equal(read('=A2', cells), 2)
    assert.equal(read('=A1 + B1', cells), 11)
    assert.equal(read('=SUM(A1:A3)', cells), 6)
    assert.equal(read('=PROD(A1:A3)', cells), 6)
    assert.equal(read('=AVG(A1:A3)', cells), 2)
    assert.equal(read('=SUM(A1:A3, B1, 4)', cells), 20)
})

test('empty and wordy cells count as zero', () => {
    const cells = sheetOf({ A1: 1, A2: '', A3: 'note' })
    assert.equal(read('=SUM(A1:A3)', cells), 1)
    assert.equal(read('=A3 + 1', cells), 1)
})

test('errors travel outward, and division by zero is one', () => {
    const cells = sheetOf({ A1: { error: '#CYCLE!' }, A2: 5 })
    assert.deepEqual(read('=A1 + A2', cells), { error: '#CYCLE!' })
    assert.deepEqual(read('=SUM(A1:A2)', cells), { error: '#CYCLE!' })
    assert.deepEqual(read('=1/0', cells), { error: '#DIV/0!' })
    assert.deepEqual(read('=NOPE(1)', cells), { error: '#NAME?' })
    assert.deepEqual(read('=1 +', cells), { error: '#SYNTAX!' })
    assert.deepEqual(read('=(1', cells), { error: '#SYNTAX!' })
})

test('what a formula names is readable without running it', () => {
    assert.deepEqual(referencesOfText('=A1 + B2').map(refName), ['A1', 'B2'])
    assert.deepEqual(referencesOfText('=SUM(A1:A3)').map(refName), ['A1', 'A2', 'A3'])
    assert.deepEqual(referencesOfText('7'), [])
})

test('shown text is short and errors show their code', () => {
    assert.equal(show(3), '3')
    assert.equal(show(1 / 3), '0.333333')
    assert.equal(show('note'), 'note')
    assert.equal(show({ error: '#REF!' }), '#REF!')
})

test('the sample sheet is a real chain, and it adds up', () => {
    const cells = sampleSheet()
    assert.equal(cells.get('A1'), '1')
    assert.equal(cells.get('B1'), '=A1 * 2')
    assert.equal(cells.get('F2'), '=F1 + D2')
    assert.equal(cells.get(key(SHEET.rows - 1, 0)), `=SUM(A1:A${SHEET.rows - 1})`)

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
    assert.equal(resolve('D1'), 1 + 2 + 3)
    assert.equal(resolve('D2'), 2 + 4 + 6)
    assert.equal(resolve('F2'), 6 + 12)
    const total = resolve(key(SHEET.rows - 1, 0))
    const rows = SHEET.rows - 1
    assert.equal(total, (rows * (rows + 1)) / 2)
    assert.equal(isError(total), false)
})

test('a cycle is the host\'s business, not the parser\'s', () => {
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