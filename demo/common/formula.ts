// The formula language, shared by both demos so the comparison is about state,
// not about parsing. Numbers, + - * / ^, parentheses, references, ranges, and
// three functions. Text counts as zero; errors travel outward.

import { parseRef, refName, spanRefs } from './address.ts'
import type { Ref } from './address.ts'
import * as dec from './dec.ts'
import type { Dec } from './dec.ts'

export type ErrorCode =
  | '#SYNTAX!'
  | '#REF!'
  | '#NAME?'
  | '#DIV/0!'
  | '#CYCLE!'
  | '#VALUE!'
  | '#NUM!'

export interface CellError {
  readonly error: ErrorCode
}

/** A cell holds an exact decimal, some words, or a complaint. */
export type Value = Dec | string | CellError

export function isError(value: Value): value is CellError {
  return typeof value === 'object' && value !== null && 'error' in value
}

export function fail(error: ErrorCode): CellError {
  return { error }
}

export function show(value: Value): string {
  if (isError(value)) return value.error
  if (typeof value === 'number') return dec.toText(value)
  return value
}

/** Two values are the same value. Numbers are counts of millionths, so this is exact. */
export function same(a: Value, b: Value): boolean {
  if (isError(a) || isError(b)) return isError(a) && isError(b) && a.error === b.error
  return a === b
}

/** Guard a result against running off the end of exact integers. */
function safe(units: number): Value {
  return dec.isSafe(units) ? (units as Dec) : fail('#NUM!')
}

// -- syntax ----------------------------------------------------------------

export type Node =
  | { readonly kind: 'number'; readonly value: Dec }
  | { readonly kind: 'ref'; readonly ref: Ref }
  | { readonly kind: 'range'; readonly from: Ref; readonly to: Ref }
  | { readonly kind: 'unary'; readonly op: '-' | '+'; readonly of: Node }
  | {
      readonly kind: 'binary'
      readonly op: '+' | '-' | '*' | '/' | '^'
      readonly left: Node
      readonly right: Node
    }
  | { readonly kind: 'call'; readonly name: string; readonly args: readonly Node[] }
  | { readonly kind: 'bad'; readonly error: ErrorCode }

type Token =
  | { kind: 'number'; value: Dec }
  | { kind: 'word'; value: string }
  | { kind: 'punct'; value: string }

function tokenize(text: string): Token[] | undefined {
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i] as string
    if (ch === ' ' || ch === '\t') {
      i++
      continue
    }
    if (ch >= '0' && ch <= '9') {
      let j = i
      while (j < text.length && /[0-9.]/.test(text[j] as string)) j++
      const value = dec.fromText(text.slice(i, j))
      if (value === undefined) return undefined
      tokens.push({ kind: 'number', value })
      i = j
      continue
    }
    if (/[A-Za-z]/.test(ch)) {
      let j = i
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j] as string)) j++
      tokens.push({ kind: 'word', value: text.slice(i, j) })
      i = j
      continue
    }
    if ('+-*/^(),:'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch })
      i++
      continue
    }
    return undefined
  }
  return tokens
}

class Reader {
  private at = 0
  private readonly tokens: Token[]

  constructor(tokens: Token[]) {
    this.tokens = tokens
  }

  peek(): Token | undefined {
    return this.tokens[this.at]
  }

  take(): Token | undefined {
    return this.tokens[this.at++]
  }

  eat(value: string): boolean {
    const token = this.peek()
    if (token?.kind === 'punct' && token.value === value) {
      this.at++
      return true
    }
    return false
  }

  done(): boolean {
    return this.at >= this.tokens.length
  }
}

const OVER_MANY = new Set(['SUM', 'PROD', 'AVG', 'MIN', 'MAX', 'COUNT'])
const OVER_ONE = new Set(['ABS', 'SQRT', 'INT', 'SIGN'])
const OVER_TWO = new Set(['MOD', 'POW'])
// ROUND takes one or two: the number, and how many digits to keep.
const FUNCTIONS = new Set([...OVER_MANY, ...OVER_ONE, ...OVER_TWO, 'ROUND'])

function parseExpr(reader: Reader): Node {
  let left = parseTerm(reader)
  for (;;) {
    if (reader.eat('+')) left = { kind: 'binary', op: '+', left, right: parseTerm(reader) }
    else if (reader.eat('-')) left = { kind: 'binary', op: '-', left, right: parseTerm(reader) }
    else return left
  }
}

function parseTerm(reader: Reader): Node {
  let left = parsePower(reader)
  for (;;) {
    if (reader.eat('*')) left = { kind: 'binary', op: '*', left, right: parsePower(reader) }
    else if (reader.eat('/')) left = { kind: 'binary', op: '/', left, right: parsePower(reader) }
    else return left
  }
}

function parsePower(reader: Reader): Node {
  const base = parseUnary(reader)
  // Right-associative, as everywhere else.
  if (reader.eat('^')) return { kind: 'binary', op: '^', left: base, right: parsePower(reader) }
  return base
}

function parseUnary(reader: Reader): Node {
  if (reader.eat('-')) return { kind: 'unary', op: '-', of: parseUnary(reader) }
  if (reader.eat('+')) return { kind: 'unary', op: '+', of: parseUnary(reader) }
  return parsePrimary(reader)
}

function parsePrimary(reader: Reader): Node {
  const token = reader.take()
  if (token === undefined) return { kind: 'bad', error: '#SYNTAX!' }

  if (token.kind === 'number') return { kind: 'number', value: token.value }

  if (token.kind === 'punct' && token.value === '(') {
    const inner = parseExpr(reader)
    if (!reader.eat(')')) return { kind: 'bad', error: '#SYNTAX!' }
    return inner
  }

  if (token.kind === 'word') {
    const upper = token.value.toUpperCase()
    if (reader.eat('(')) {
      const args: Node[] = []
      if (!reader.eat(')')) {
        for (;;) {
          args.push(parseArg(reader))
          if (reader.eat(')')) break
          if (!reader.eat(',')) return { kind: 'bad', error: '#SYNTAX!' }
        }
      }
      // Read the call out even when the name is unknown, so the complaint is
      // about the name rather than about the leftovers.
      if (!FUNCTIONS.has(upper)) return { kind: 'bad', error: '#NAME?' }
      return { kind: 'call', name: upper, args }
    }
    const ref = parseRef(token.value)
    if (ref === undefined) return { kind: 'bad', error: '#NAME?' }
    return { kind: 'ref', ref }
  }

  return { kind: 'bad', error: '#SYNTAX!' }
}

/** An argument may be a range, which is only meaningful here. */
function parseArg(reader: Reader): Node {
  const first = parseExpr(reader)
  if (first.kind === 'ref' && reader.eat(':')) {
    const second = parsePrimary(reader)
    if (second.kind !== 'ref') return { kind: 'bad', error: '#SYNTAX!' }
    return { kind: 'range', from: first.ref, to: second.ref }
  }
  return first
}

const parsed = new Map<string, Node>()

/** Parse the body of a formula (without the leading '='). Cached by text. */
export function parse(body: string): Node {
  const known = parsed.get(body)
  if (known !== undefined) return known
  const tokens = tokenize(body)
  let node: Node
  if (tokens === undefined || tokens.length === 0) {
    node = { kind: 'bad', error: '#SYNTAX!' }
  } else {
    const reader = new Reader(tokens)
    node = parseExpr(reader)
    if (!reader.done()) node = { kind: 'bad', error: '#SYNTAX!' }
  }
  parsed.set(body, node)
  return node
}

// -- meaning ---------------------------------------------------------------

/** Functions that can be answered block by block, because they fold. */
export type FoldName = 'SUM' | 'PROD' | 'MIN' | 'MAX' | 'COUNT'

export interface Lookup {
  /** The value of another cell. Whoever implements this decides how dependencies are noticed. */
  value(ref: Ref): Value
  /**
   * A whole range at once, if the host can do better than cell by cell.
   * Undefined means "read it the ordinary way".
   */
  fold?(name: FoldName, from: Ref, to: Ref): Value | undefined
}

const FOLDABLE = new Set<string>(['SUM', 'PROD', 'MIN', 'MAX', 'COUNT'])

/** How many cells a range covers — AVG divides by this, blanks included. */
function spanSize(from: Ref, to: Ref): number {
  return (Math.abs(from.row - to.row) + 1) * (Math.abs(from.col - to.col) + 1)
}

/** Text counts as zero, as in a spreadsheet; a complaint stays a complaint. */
export function asDec(value: Value): Dec | CellError {
  if (isError(value)) return value
  if (typeof value === 'number') return value
  return dec.fromText(value) ?? dec.ZERO
}

/** The raw values an argument stands for: a range spreads out, anything else is itself. */
function gather(node: Node, lookup: Lookup): Value[] | CellError {
  if (node.kind === 'range') {
    const values: Value[] = []
    for (const ref of spanRefs(node.from, node.to)) {
      const value = lookup.value(ref)
      if (isError(value)) return value
      values.push(value)
    }
    return values
  }
  const value = evaluate(node, lookup)
  return isError(value) ? value : [value]
}

/** A cell counts as a number when it holds one, or holds text that reads as one. */
export function counts(value: Value): boolean {
  if (typeof value === 'number') return true
  return typeof value === 'string' && dec.fromText(value) !== undefined
}

function numbersOf(values: Value[]): Dec[] {
  const numbers: Dec[] = []
  for (const value of values) {
    const n = asDec(value)
    if (typeof n === 'number') numbers.push(n)
  }
  return numbers
}

function total(numbers: Dec[]): Dec {
  let sum = dec.ZERO
  for (const n of numbers) sum = dec.add(sum, n)
  return sum
}

function power(base: Dec, exponent: Dec): Value {
  const whole = dec.toFloat(exponent)
  if (Number.isInteger(whole) && Math.abs(whole) <= 32) {
    let result = dec.fromInt(1)
    for (let i = 0; i < Math.abs(whole); i++) result = dec.mul(result, base)
    if (whole >= 0) return safe(result)
    const inverted = dec.div(dec.fromInt(1), result)
    return inverted === undefined ? fail('#DIV/0!') : inverted
  }
  return dec.fromFloat(dec.toFloat(base) ** whole)
}

function callFunction(name: string, values: Value[]): Value {
  const numbers = numbersOf(values)
  const one = numbers[0] as Dec
  const two = numbers[1] as Dec
  switch (name) {
    case 'SUM':
      return safe(total(numbers))
    case 'PROD': {
      let product = dec.fromInt(1)
      for (const n of numbers) product = dec.mul(product, n)
      return safe(product)
    }
    case 'AVG': {
      if (numbers.length === 0) return fail('#DIV/0!')
      const mean = dec.div(total(numbers), dec.fromInt(numbers.length))
      return mean ?? fail('#DIV/0!')
    }
    case 'MIN':
      return numbers.length === 0
        ? dec.ZERO
        : numbers.reduce((a, b) => (dec.cmp(a, b) <= 0 ? a : b))
    case 'MAX':
      return numbers.length === 0
        ? dec.ZERO
        : numbers.reduce((a, b) => (dec.cmp(a, b) >= 0 ? a : b))
    case 'COUNT':
      return dec.fromInt(values.filter(counts).length)
    case 'ABS':
      return numbers.length === 1 ? dec.abs(one) : fail('#VALUE!')
    case 'INT':
      return numbers.length === 1 ? dec.trunc(one) : fail('#VALUE!')
    case 'SIGN':
      return numbers.length === 1 ? dec.sign(one) : fail('#VALUE!')
    case 'SQRT':
      if (numbers.length !== 1) return fail('#VALUE!')
      return one < 0 ? fail('#VALUE!') : dec.fromFloat(Math.sqrt(dec.toFloat(one)))
    case 'MOD':
      if (numbers.length !== 2) return fail('#VALUE!')
      return dec.rem(one, two) ?? fail('#DIV/0!')
    case 'POW':
      return numbers.length === 2 ? power(one, two) : fail('#VALUE!')
    case 'ROUND': {
      if (numbers.length === 0 || numbers.length > 2) return fail('#VALUE!')
      return dec.round(one, numbers.length === 2 ? dec.toFloat(two) : 0)
    }
    default:
      return fail('#NAME?')
  }
}

export function evaluate(node: Node, lookup: Lookup): Value {
  switch (node.kind) {
    case 'number':
      return node.value
    case 'bad':
      return fail(node.error)
    case 'ref':
      return lookup.value(node.ref)
    case 'range':
      return fail('#SYNTAX!') // a range only means something inside a function
    case 'unary': {
      const of = asDec(evaluate(node.of, lookup))
      if (typeof of !== 'number') return of
      return node.op === '-' ? dec.neg(of) : of
    }
    case 'binary': {
      const left = asDec(evaluate(node.left, lookup))
      if (typeof left !== 'number') return left
      const right = asDec(evaluate(node.right, lookup))
      if (typeof right !== 'number') return right
      switch (node.op) {
        case '+':
          return safe(dec.add(left, right))
        case '-':
          return safe(dec.sub(left, right))
        case '*':
          return safe(dec.mul(left, right))
        case '/':
          return dec.div(left, right) ?? fail('#DIV/0!')
        case '^':
          return power(left, right)
      }
      return fail('#SYNTAX!')
    }
    case 'call': {
      const only = node.args.length === 1 ? node.args[0] : undefined
      if (lookup.fold !== undefined && only !== undefined && only.kind === 'range') {
        if (FOLDABLE.has(node.name)) {
          const folded = lookup.fold(node.name as FoldName, only.from, only.to)
          if (folded !== undefined) return folded
        }
        if (node.name === 'AVG') {
          const sum = lookup.fold('SUM', only.from, only.to)
          if (sum !== undefined) {
            if (isError(sum)) return sum
            const mean = dec.div(sum as Dec, dec.fromInt(spanSize(only.from, only.to)))
            return mean ?? fail('#DIV/0!')
          }
        }
      }
      const values: Value[] = []
      for (const arg of node.args) {
        const some = gather(arg, lookup)
        if (!Array.isArray(some)) return some
        values.push(...some)
      }
      return callFunction(node.name, values)
    }
  }
}

/** What a cell's text means before anything is looked up. */
export type Plan =
  | { readonly kind: 'formula'; readonly node: Node }
  | { readonly kind: 'plain'; readonly value: Value }

/** Text -> plan. Depends on the text alone, so it survives a neighbour changing. */
export function plan(text: string): Plan {
  const body = text.trim()
  if (body.startsWith('=')) return { kind: 'formula', node: parse(body.slice(1)) }
  if (body === '') return { kind: 'plain', value: '' }
  return { kind: 'plain', value: dec.fromText(body) ?? body }
}

/** Plan -> value. This is the part that reads other cells. */
export function run(what: Plan, lookup: Lookup): Value {
  return what.kind === 'plain' ? what.value : evaluate(what.node, lookup)
}

/** Both steps at once, for callers with nowhere to keep the plan. */
export function read(text: string, lookup: Lookup): Value {
  return run(plan(text), lookup)
}

export { refName }
