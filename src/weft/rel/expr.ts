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
  /** A named hole: the tree stays one value, the parameter lives outside and
   *  is substituted before anything runs. Canon writes it as ?name. */
  | { is: 'param'; name: string }
  | { is: 'cmp'; op: '==' | '!=' | '<' | '<=' | '>' | '>=' | 'has'; left: Expr; right: Expr }
  | { is: 'and'; parts: readonly Expr[] }
  | { is: 'or'; parts: readonly Expr[] }
  | { is: 'not'; part: Expr }
  | { is: 'math'; op: '+' | '-' | '*' | '/'; left: Expr; right: Expr }
  | { is: 'some'; part: Expr }

/** Shorthands: the corpus and the tests write trees, people write these. */
export const field = (...path: string[]): Expr => ({ is: 'field', path })
export const lit = (value: unknown): Expr => ({ is: 'lit', value })
export const param = (name: string): Expr => ({ is: 'param', name })
export const cmp = (
  op: '==' | '!=' | '<' | '<=' | '>' | '>=' | 'has',
  left: Expr,
  right: Expr,
): Expr => ({
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
    case 'param':
      throw new Error(`weft rel: parameter ?${expr.name} was never given a value`)
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
        case 'has':
          return String(l).includes(String(r))
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

/** The same expression with every hole filled by its current value. */
export function substituteExpr(expr: Expr, values: ReadonlyMap<string, unknown>): Expr {
  switch (expr.is) {
    case 'field':
    case 'lit':
      return expr
    case 'param': {
      if (!values.has(expr.name)) {
        throw new Error(`weft rel: parameter ?${expr.name} was never given a value`)
      }
      return { is: 'lit', value: values.get(expr.name) }
    }
    case 'cmp':
      return {
        is: 'cmp',
        op: expr.op,
        left: substituteExpr(expr.left, values),
        right: substituteExpr(expr.right, values),
      }
    case 'and':
      return { is: 'and', parts: expr.parts.map(p => substituteExpr(p, values)) }
    case 'or':
      return { is: 'or', parts: expr.parts.map(p => substituteExpr(p, values)) }
    case 'not':
      return { is: 'not', part: substituteExpr(expr.part, values) }
    case 'math':
      return {
        is: 'math',
        op: expr.op,
        left: substituteExpr(expr.left, values),
        right: substituteExpr(expr.right, values),
      }
    case 'some':
      return { is: 'some', part: substituteExpr(expr.part, values) }
  }
}

/** Every hole under an expression, by name. */
export function paramsOfExpr(expr: Expr, out: Set<string> = new Set()): Set<string> {
  switch (expr.is) {
    case 'field':
    case 'lit':
      return out
    case 'param':
      out.add(expr.name)
      return out
    case 'cmp':
    case 'math':
      paramsOfExpr(expr.left, out)
      return paramsOfExpr(expr.right, out)
    case 'and':
    case 'or':
      for (const p of expr.parts) paramsOfExpr(p, out)
      return out
    case 'not':
    case 'some':
      return paramsOfExpr(expr.part, out)
  }
}

/** One string per expression, stable across key order — the hash's food. */
export function canonExpr(expr: Expr): string {
  switch (expr.is) {
    case 'field':
      return `.${expr.path.join('.')}`
    case 'lit':
      return JSON.stringify(expr.value) ?? 'undefined'
    case 'param':
      return `?${expr.name}`
    case 'cmp': {
      const op = expr.op === 'has' ? ' has ' : expr.op
      return `(${canonExpr(expr.left)}${op}${canonExpr(expr.right)})`
    }
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
