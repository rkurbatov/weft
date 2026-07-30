// Exact decimal arithmetic for the sheet.
//
// A value is an integer count of millionths, so addition is plain integer
// addition: exact, and — the point of all this — associative. A total built out
// of block sums is then the same number as a total added up left to right, to
// the last digit. Floating point gives neither, which is why anything meant to
// be recomputed in pieces cannot rest on it.

/** A count of millionths. Branded so it cannot be mixed up with a plain number. */
export type Dec = number & { readonly dec: unique symbol }

export const PLACES = 6
const ONE = 1_000_000
const ONE_BIG = BigInt(ONE)
const LIMIT = Number.MAX_SAFE_INTEGER

export const ZERO = 0 as Dec

export function isSafe(units: number): boolean {
    return Number.isFinite(units) && Math.abs(units) <= LIMIT
}

function units(n: number): Dec {
    return n as Dec
}

/** Halfway goes to the even side, so rounding does not drift in long sums. */
function divide(top: bigint, bottom: bigint): bigint {
    const negative = top < 0n !== bottom < 0n
    const t = top < 0n ? -top : top
    const b = bottom < 0n ? -bottom : bottom
    const whole = t / b
    const twice = (t % b) * 2n
    const up = twice > b || (twice === b && whole % 2n === 1n)
    const result = up ? whole + 1n : whole
    return negative ? -result : result
}

export function fromInt(n: number): Dec {
    return units(Math.round(n) * ONE)
}

/** A float, rounded to the places we keep. For SQRT and friends. */
export function fromFloat(x: number): Dec {
    return units(Math.round(x * ONE))
}

export function toFloat(d: Dec): number {
    return d / ONE
}

const TEXT = /^[+-]?(\d+)?(\.\d+)?$/

export function fromText(text: string): Dec | undefined {
    const body = text.trim()
    if (body === '' || body === '+' || body === '-' || !TEXT.test(body)) return undefined
    const negative = body.startsWith('-')
    const bare = body.replace(/^[+-]/, '')
    const [whole = '0', fraction = ''] = bare.split('.')
    const kept = `${fraction}000000`.slice(0, PLACES)
    const value = Number(whole) * ONE + Number(kept || '0')
    if (!isSafe(value)) return undefined
    return units(negative ? -value : value)
}

export function toText(d: Dec): string {
    const negative = d < 0
    const all = Math.abs(d)
    const whole = Math.floor(all / ONE)
    const fraction = String(all % ONE)
        .padStart(PLACES, '0')
        .replace(/0+$/, '')
    const body = fraction === '' ? String(whole) : `${whole}.${fraction}`
    return negative && (whole !== 0 || fraction !== '') ? `-${body}` : body
}

// -- arithmetic ------------------------------------------------------------
// add and sub are exact and associative; mul and div round once, half to even.

export function add(a: Dec, b: Dec): Dec {
    return units(a + b)
}

export function sub(a: Dec, b: Dec): Dec {
    return units(a - b)
}

export function neg(a: Dec): Dec {
    return units(-a)
}

export function abs(a: Dec): Dec {
    return units(Math.abs(a))
}

export function mul(a: Dec, b: Dec): Dec {
    return units(Number(divide(BigInt(a) * BigInt(b), ONE_BIG)))
}

/** Undefined when the divisor is zero — the caller decides what that means. */
export function div(a: Dec, b: Dec): Dec | undefined {
    if (b === 0) return undefined
    return units(Number(divide(BigInt(a) * ONE_BIG, BigInt(b))))
}

export function rem(a: Dec, b: Dec): Dec | undefined {
    if (b === 0) return undefined
    return units(a % b)
}

export function cmp(a: Dec, b: Dec): number {
    return a < b ? -1 : a > b ? 1 : 0
}

/** Round to the given number of places, half to even. */
export function round(a: Dec, places: number): Dec {
    const keep = Math.min(Math.max(Math.trunc(places), 0), PLACES)
    const step = BigInt(10 ** (PLACES - keep))
    return units(Number(divide(BigInt(a), step) * step))
}

export function trunc(a: Dec): Dec {
    return units(Math.trunc(a / ONE) * ONE)
}

export function sign(a: Dec): Dec {
    return fromInt(Math.sign(a))
}