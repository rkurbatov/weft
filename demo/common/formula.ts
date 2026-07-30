// The formula language, shared by both demos so the comparison is about state,
// not about parsing. Numbers, + - * / ^, parentheses, references, ranges, and
// three functions. Text counts as zero; errors travel outward.

import { parseRef, refName, spanRefs } from './address.ts'
import type { Ref } from './address.ts'

export type ErrorCode = '#SYNTAX!' | '#REF!' | '#NAME?' | '#DIV/0!' | '#CYCLE!' | '#VALUE!'

export interface CellError {
    readonly error: ErrorCode
}

export type Value = number | string | CellError

export function isError(value: Value): value is CellError {
    return typeof value === 'object' && value !== null && 'error' in value
}

export function fail(error: ErrorCode): CellError {
    return { error }
}

export function show(value: Value): string {
    if (isError(value)) return value.error
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return '#DIV/0!'
        return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e6) / 1e6)
    }
    return value
}

// -- syntax ----------------------------------------------------------------

export type Node =
    | { readonly kind: 'number'; readonly value: number }
    | { readonly kind: 'ref'; readonly ref: Ref }
    | { readonly kind: 'range'; readonly from: Ref; readonly to: Ref }
    | { readonly kind: 'unary'; readonly op: '-' | '+'; readonly of: Node }
    | { readonly kind: 'binary'; readonly op: '+' | '-' | '*' | '/' | '^'; readonly left: Node; readonly right: Node }
    | { readonly kind: 'call'; readonly name: string; readonly args: readonly Node[] }
    | { readonly kind: 'bad'; readonly error: ErrorCode }

type Token =
    | { kind: 'number'; value: number }
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
            const value = Number(text.slice(i, j))
            if (Number.isNaN(value)) return undefined
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

export interface Lookup {
    /** The value of another cell. Whoever implements this decides how dependencies are noticed. */
    value(ref: Ref): Value
}

function asNumber(value: Value): number | CellError {
    if (isError(value)) return value
    if (typeof value === 'number') return value
    if (value.trim() === '') return 0
    const n = Number(value)
    return Number.isNaN(n) ? 0 : n // text counts as zero, as in a spreadsheet
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
function counts(value: Value): boolean {
    if (typeof value === 'number') return true
    if (typeof value !== 'string' || value.trim() === '') return false
    return !Number.isNaN(Number(value))
}

function numbersOf(values: Value[]): number[] {
    const numbers: number[] = []
    for (const value of values) {
        const n = asNumber(value)
        if (typeof n === 'number') numbers.push(n)
    }
    return numbers
}

function callFunction(name: string, values: Value[], raw: Value[]): Value {
    const numbers = numbersOf(values)
    switch (name) {
        case 'SUM':
            return numbers.reduce((a, b) => a + b, 0)
        case 'PROD':
            return numbers.reduce((a, b) => a * b, 1)
        case 'AVG':
            return numbers.length === 0
                ? fail('#DIV/0!')
                : numbers.reduce((a, b) => a + b, 0) / numbers.length
        case 'MIN':
            return numbers.length === 0 ? 0 : Math.min(...numbers)
        case 'MAX':
            return numbers.length === 0 ? 0 : Math.max(...numbers)
        case 'COUNT':
            return raw.filter(counts).length
        case 'ABS':
            return numbers.length === 1 ? Math.abs(numbers[0] as number) : fail('#VALUE!')
        case 'INT':
            return numbers.length === 1 ? Math.trunc(numbers[0] as number) : fail('#VALUE!')
        case 'SIGN':
            return numbers.length === 1 ? Math.sign(numbers[0] as number) : fail('#VALUE!')
        case 'SQRT': {
            if (numbers.length !== 1) return fail('#VALUE!')
            const n = numbers[0] as number
            return n < 0 ? fail('#VALUE!') : Math.sqrt(n)
        }
        case 'MOD': {
            if (numbers.length !== 2) return fail('#VALUE!')
            const divisor = numbers[1] as number
            return divisor === 0 ? fail('#DIV/0!') : (numbers[0] as number) % divisor
        }
        case 'POW':
            return numbers.length === 2 ? (numbers[0] as number) ** (numbers[1] as number) : fail('#VALUE!')
        case 'ROUND': {
            if (numbers.length === 0 || numbers.length > 2) return fail('#VALUE!')
            const digits = numbers.length === 2 ? Math.trunc(numbers[1] as number) : 0
            const scale = 10 ** digits
            return Math.round((numbers[0] as number) * scale) / scale
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
            const of = asNumber(evaluate(node.of, lookup))
            if (typeof of !== 'number') return of
            return node.op === '-' ? -of : of
        }
        case 'binary': {
            const left = asNumber(evaluate(node.left, lookup))
            if (typeof left !== 'number') return left
            const right = asNumber(evaluate(node.right, lookup))
            if (typeof right !== 'number') return right
            switch (node.op) {
                case '+':
                    return left + right
                case '-':
                    return left - right
                case '*':
                    return left * right
                case '/':
                    return right === 0 ? fail('#DIV/0!') : left / right
                case '^':
                    return left ** right
            }
            return fail('#SYNTAX!')
        }
        case 'call': {
            const values: Value[] = []
            for (const arg of node.args) {
                const some = gather(arg, lookup)
                if (!Array.isArray(some)) return some
                values.push(...some)
            }
            return callFunction(node.name, values, values)
        }
    }
}

/** Read a cell's text: a formula, a number, or plain words. */
export function read(text: string, lookup: Lookup): Value {
    const body = text.trim()
    if (body.startsWith('=')) return evaluate(parse(body.slice(1)), lookup)
    if (body === '') return ''
    const n = Number(body)
    return Number.isNaN(n) ? body : n
}

/** Which cells a formula names. The hand-written demo needs this; the weft one does not. */
export function referencesOf(node: Node): Ref[] {
    switch (node.kind) {
        case 'ref':
            return [node.ref]
        case 'range':
            return spanRefs(node.from, node.to)
        case 'unary':
            return referencesOf(node.of)
        case 'binary':
            return [...referencesOf(node.left), ...referencesOf(node.right)]
        case 'call':
            return node.args.flatMap(referencesOf)
        default:
            return []
    }
}

export function referencesOfText(text: string): Ref[] {
    const body = text.trim()
    if (!body.startsWith('=')) return []
    return referencesOf(parse(body.slice(1)))
}

export { refName }