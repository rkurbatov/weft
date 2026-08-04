// Expressions as data — the reason a node tree is a value and not a program.
// A predicate or a computed field written in this form serialises with its
// node, hashes canonically, and runs unchanged against the Go implementation:
// one scenario file, two engines. A closure can stand anywhere an Expr can
// (see node.ts), but a node holding one declares itself non-canonical.
//
// Semantics are deliberately pinned here, because a cross-implementation
// corpus needs one answer, not two: numbers are IEEE doubles with JS
// arithmetic (division by zero included), comparisons are JS `<`/`===` —
// strings lexicographic, mixed types compare as JS does — and `some` means
// neither null nor undefined. A row field is read by path, so a nested row
// (a join's right side under its alias) is `['c', 'id']`.

export type Row = Record<string, unknown>

export type Expr =
  | { is: 'field'; path: readonly string[] }
  | { is: 'lit'; value: unknown }
  | { is: 'cmp'; op: '==' | '!=' | '<' | '<=' | '>' | '>='; left: Expr; right: Expr }
  | { is: 'and'; parts: readonly Expr[] }
  | { is: 'or'; parts: readonly Expr[] }
  | { is: 'not'; part: Expr }
  | { is: 'math'; op: '+' | '-' | '*' | '/'; left: Expr; right: Expr }
  | { is: 'some'; part: Expr }

/** Shorthands: the corpus and the tests write trees, people write these. */
export const field = (...path: string[]): Expr => ({ is: 'field', path })
export const lit = (value: unknown): Expr => ({ is: 'lit', value })
export const cmp = (op: '==' | '!=' | '<' | '<=' | '>' | '>=', left: Expr, right: Expr): Expr => ({
  is: 'cmp',
  op,
  left,
  right,
})
export const and = (...parts: Expr[]): Expr => ({ is: 'and', parts })
export const or = (...parts: Expr[]): Expr => ({ is: 'or', parts })
export const not = (part: Expr): Expr => ({ is: 'not', part })
export const math = (op: '+' | '-' | '*' | '/', left: Expr, right: Expr): Expr => ({
  is: 'math',
  op,
  left,
  right,
})
export const some = (part: Expr): Expr => ({ is: 'some', part })

export function evalExpr(expr: Expr, row: Row): unknown {
  switch (expr.is) {
    case 'field': {
      let at: unknown = row
      for (const step of expr.path) {
        if (at === null || typeof at !== 'object') return undefined
        at = (at as Row)[step]
      }
      return at
    }
    case 'lit':
      return expr.value
    case 'cmp': {
      const l = evalExpr(expr.left, row)
      const r = evalExpr(expr.right, row)
      switch (expr.op) {
        case '==':
          return l === r
        case '!=':
          return l !== r
        case '<':
          return (l as number) < (r as number)
        case '<=':
          return (l as number) <= (r as number)
        case '>':
          return (l as number) > (r as number)
        case '>=':
          return (l as number) >= (r as number)
      }
      break
    }
    case 'and':
      return expr.parts.every(p => evalExpr(p, row) === true)
    case 'or':
      return expr.parts.some(p => evalExpr(p, row) === true)
    case 'not':
      return evalExpr(expr.part, row) !== true
    case 'math': {
      const l = evalExpr(expr.left, row) as number
      const r = evalExpr(expr.right, row) as number
      switch (expr.op) {
        case '+':
          return l + r
        case '-':
          return l - r
        case '*':
          return l * r
        case '/':
          return l / r
      }
      break
    }
    case 'some': {
      const v = evalExpr(expr.part, row)
      return v !== null && v !== undefined
    }
  }
}

export const truthy = (expr: Expr, row: Row): boolean => evalExpr(expr, row) === true

/** One string per expression, stable across key order — the hash's food. */
export function canonExpr(expr: Expr): string {
  switch (expr.is) {
    case 'field':
      return `.${expr.path.join('.')}`
    case 'lit':
      return JSON.stringify(expr.value) ?? 'undefined'
    case 'cmp':
      return `(${canonExpr(expr.left)}${expr.op}${canonExpr(expr.right)})`
    case 'and':
      return `(and ${expr.parts.map(canonExpr).join(' ')})`
    case 'or':
      return `(or ${expr.parts.map(canonExpr).join(' ')})`
    case 'not':
      return `(not ${canonExpr(expr.part)})`
    case 'math':
      return `(${canonExpr(expr.left)}${expr.op}${canonExpr(expr.right)})`
    case 'some':
      return `(some ${canonExpr(expr.part)})`
  }
}
