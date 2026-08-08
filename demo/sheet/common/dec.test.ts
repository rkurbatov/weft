import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  add,
  cmp,
  div,
  fromFloat,
  fromInt,
  fromText,
  mul,
  rem,
  round,
  sub,
  toText,
  trunc,
  sign,
  PLACES,
} from './dec.ts'
import type { Dec } from './dec.ts'

const d = (text: string): Dec => {
  const value = fromText(text)
  assert.notEqual(value, undefined, `bad literal ${text}`)
  return value as Dec
}

test('text in, text out', () => {
  assert.equal(toText(d('1')), '1')
  assert.equal(toText(d('0.1')), '0.1')
  assert.equal(toText(d('-2.50')), '-2.5')
  assert.equal(toText(d('.75')), '0.75')
  assert.equal(toText(d('12.3456789')), '12.345678') // kept to six places
  assert.equal(fromText('note'), undefined)
  assert.equal(fromText(''), undefined)
})

test('the sum that floating point gets wrong', () => {
  assert.equal(toText(add(d('0.1'), d('0.2'))), '0.3')
  assert.notEqual(0.1 + 0.2, 0.3)
})

test('addition is associative, whichever way a total is built', () => {
  const parts = Array.from({ length: 1000 }, (_, i) => d(`${i}.001`))
  const left = parts.reduce(add, fromInt(0))
  const blocks: Dec[] = []
  for (let at = 0; at < parts.length; at += 32) {
    blocks.push(parts.slice(at, at + 32).reduce(add, fromInt(0)))
  }
  const byBlocks = blocks.reduce(add, fromInt(0))
  assert.equal(left, byBlocks) // the same number, not merely a close one
})

test('multiplication and division round once, half to even', () => {
  assert.equal(toText(mul(d('1.5'), d('2'))), '3')
  assert.equal(toText(mul(d('0.000001'), d('0.5'))), '0') // 0.0000005 -> even
  assert.equal(toText(mul(d('0.000003'), d('0.5'))), '0.000002') // 0.0000015 -> even
  assert.equal(toText(div(d('10'), d('4')) as Dec), '2.5')
  assert.equal(toText(div(d('1'), d('3')) as Dec), '0.333333')
  assert.equal(div(d('1'), d('0')), undefined)
})

test('the small useful ones', () => {
  assert.equal(toText(sub(d('1'), d('0.3'))), '0.7')
  assert.equal(toText(round(d('3.14159'), 2)), '3.14')
  assert.equal(toText(round(d('2.5'), 0)), '2') // half to even
  assert.equal(toText(round(d('3.5'), 0)), '4')
  assert.equal(toText(trunc(d('-3.9'))), '-3')
  assert.equal(toText(sign(d('-3.9'))), '-1')
  assert.equal(toText(rem(d('9'), d('7')) as Dec), '2')
  assert.equal(cmp(d('1'), d('2')), -1)
})

test('a float comes in rounded to the places we keep', () => {
  assert.equal(toText(fromFloat(Math.sqrt(9))), '3')
  assert.equal(toText(fromFloat(Math.sqrt(2))), '1.414214')
  assert.equal(PLACES, 6)
})
