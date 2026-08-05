// Derived addresses. A1 on the outside, row and column numbers on the inside.

export interface Ref {
  readonly row: number
  readonly col: number
}

const A = 'A'.charCodeAt(0)

export function columnName(col: number): string {
  let name = ''
  let n = col
  for (;;) {
    name = String.fromCharCode(A + (n % 26)) + name
    n = Math.floor(n / 26) - 1
    if (n < 0) return name
  }
}

export function columnNumber(name: string): number {
  let n = 0
  for (const letter of name.toUpperCase()) n = n * 26 + (letter.charCodeAt(0) - A + 1)
  return n - 1
}

export function refName(ref: Ref): string {
  return `${columnName(ref.col)}${ref.row + 1}`
}

const REF = /^([A-Za-z]+)([0-9]+)$/

export function parseRef(text: string): Ref | undefined {
  const found = REF.exec(text.trim())
  if (found === null) return undefined
  const [, letters, digits] = found
  if (letters === undefined || digits === undefined) return undefined
  const row = Number(digits) - 1
  if (row < 0) return undefined
  return { row, col: columnNumber(letters) }
}

/** Every cell of the rectangle between two corners, row by row. */
export function spanRefs(from: Ref, to: Ref): Ref[] {
  const rows = [Math.min(from.row, to.row), Math.max(from.row, to.row)]
  const cols = [Math.min(from.col, to.col), Math.max(from.col, to.col)]
  const refs: Ref[] = []
  for (let row = rows[0] as number; row <= (rows[1] as number); row++) {
    for (let col = cols[0] as number; col <= (cols[1] as number); col++) refs.push({ row, col })
  }
  return refs
}
