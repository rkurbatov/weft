// The relational tree: a derived collection as data, not as a closure.
//
// A node is a plain value — primitive, attributes, inputs — following the
// thirteen-primitive table of the language corpus (Warp 10-IR); this file
// carries the ones implemented so far and grows one primitive at a time.
// Expressions inside attributes are data too (expr.ts), so a whole tree
// serialises, hashes and runs against another implementation. A closure may
// stand in for any expression as an escape hatch, and the tree then honestly
// loses its canon: no hash, no place in the cross-implementation corpus.
//
// Keys are declared, not guessed: a source names the fields its key is made
// of, and every derivation's key follows by rule — filter and pure inherit.
// That is what lets a derived row be found, moved and explained by key, and
// a `pure` that picks away a key field is a build error, not a surprise.
//
// The naive recount here is the oracle: the slowest correct answer, the
// floor every faster path is measured against — and the resync path when a
// follower falls too far behind.

import { canonExpr, evalExpr, truthy } from './expr.ts'
import type { Expr, Row } from './expr.ts'
import type { Key } from '../core/table/table.ts'

/** The escape hatch: any expression may be a function instead. */
export type RowFn = (row: Row) => unknown

export interface SourceNode {
  prim: 'source'
  /** Which named source feeds this leaf. */
  source: string
  /** Field names whose values form a row's key, in order. */
  key: readonly string[]
}

export interface PureNode {
  prim: 'pure'
  input: RelNode
  /** Computed fields; each sees the original row, not its siblings. */
  fields?: Record<string, Expr | RowFn>
  /** Projection: which fields survive. Key fields must. */
  pick?: readonly string[]
}

export interface FilterNode {
  prim: 'filter'
  input: RelNode
  test: Expr | RowFn
}

export interface JoinNode {
  prim: 'join'
  left: RelNode
  right: RelNode
  /** The right row lands nested under this name in the merged row. */
  as: string
  /** Equi keys: left field == right field, both top-level names. */
  on: ReadonlyArray<{ left: string; right: string }>
  /** Over the merged row; a pair failing it is not a match. */
  residual?: Expr | RowFn
  /** All left rows survive; an unmatched right side is null, its fields t?. */
  keeping?: boolean
}

export type RelNode = SourceNode | PureNode | FilterNode | JoinNode

export const source = (name: string, key: readonly string[]): SourceNode => ({
  prim: 'source',
  source: name,
  key,
})
export const pure = (
  input: RelNode,
  attrs: { fields?: Record<string, Expr | RowFn>; pick?: readonly string[] },
): PureNode => ({ prim: 'pure', input, ...attrs })
export const filter = (input: RelNode, test: Expr | RowFn): FilterNode => ({
  prim: 'filter',
  input,
  test,
})
export const join = (
  left: RelNode,
  right: RelNode,
  attrs: {
    as: string
    on: ReadonlyArray<{ left: string; right: string }>
    residual?: Expr | RowFn
    keeping?: boolean
  },
): JoinNode => ({ prim: 'join', left, right, ...attrs })

/** The paths a node's key is made of — inherited until a primitive says
 *  otherwise; a join's key is both parents' keys, the right side under its
 *  alias. Paths, not names, because a merged row nests. */
export function keyPaths(node: RelNode): ReadonlyArray<readonly string[]> {
  switch (node.prim) {
    case 'source':
      return node.key.map(f => [f])
    case 'pure':
    case 'filter':
      return keyPaths(node.input)
    case 'join':
      return [...keyPaths(node.left), ...keyPaths(node.right).map(p => [node.as].concat(p))]
  }
}

const readPath = (row: Row, path: readonly string[]): unknown => {
  let at: unknown = row
  for (const step of path) {
    if (at === null || typeof at !== 'object') return null
    at = (at as Row)[step]
  }
  return at ?? null
}

/** A row's key under a node's rule: one path plain, several as a joined form. */
export function keyOfRow(node: RelNode, row: Row): Key {
  const paths = keyPaths(node)
  if (paths.length === 1) return readPath(row, paths[0] as readonly string[]) as Key
  return JSON.stringify(paths.map(p => readPath(row, p)))
}

/** A parent's key value inside a composite, back in its own form. */
const recomposeKey = (node: RelNode, values: unknown[]): Key =>
  keyPaths(node).length === 1 ? (values[0] as Key) : JSON.stringify(values)

const isExpr = (e: Expr | RowFn): e is Expr => typeof e !== 'function'

/** Canon of the tree, or null when a closure stands anywhere inside. */
export function canonNode(node: RelNode): string | null {
  switch (node.prim) {
    case 'source':
      return `(source ${node.source} key=${node.key.join(',')})`
    case 'filter': {
      const under = canonNode(node.input)
      if (under === null || !isExpr(node.test)) return null
      return `(filter ${canonExpr(node.test)} ${under})`
    }
    case 'join': {
      const left = canonNode(node.left)
      const right = canonNode(node.right)
      if (left === null || right === null) return null
      let residual = ''
      if (node.residual !== undefined) {
        if (!isExpr(node.residual)) return null
        residual = ` where=${canonExpr(node.residual)}`
      }
      const on = node.on.map(p => `${p.left}=${p.right}`).join(',')
      const keeping = node.keeping === true ? ' keeping' : ''
      return `(join as=${node.as} on=${on}${residual}${keeping} ${left} ${right})`
    }
    case 'pure': {
      const under = canonNode(node.input)
      if (under === null) return null
      const fields = Object.entries(node.fields ?? {}).toSorted(([a], [b]) => (a < b ? -1 : 1))
      const parts: string[] = []
      for (const [name, e] of fields) {
        if (!isExpr(e)) return null
        parts.push(`${name}=${canonExpr(e)}`)
      }
      const pick = node.pick === undefined ? '' : ` pick=${node.pick.join(',')}`
      return `(pure {${parts.join(' ')}}${pick} ${under})`
    }
  }
}

/** What `pure` does to one row; shared by the oracle and the live path. */
export function pureRow(node: PureNode, row: Row): Row {
  let out: Row = row
  if (node.fields !== undefined) {
    out = { ...row }
    for (const [name, e] of Object.entries(node.fields)) {
      out[name] = isExpr(e) ? evalExpr(e, row) : e(row)
    }
  }
  if (node.pick !== undefined) {
    const kept: Row = {}
    for (const name of node.pick) kept[name] = out[name]
    out = kept
  }
  return out
}

export const passesFilter = (node: FilterNode, row: Row): boolean =>
  isExpr(node.test) ? truthy(node.test, row) : node.test(row) === true

/** Build errors are caught before anything runs; the message names the node. */
export function checkNode(node: RelNode): void {
  switch (node.prim) {
    case 'source':
      if (node.key.length === 0) throw new Error(`weft rel: source ${node.source} declares no key`)
      return
    case 'filter':
      checkNode(node.input)
      return
    case 'pure': {
      checkNode(node.input)
      const heads = new Set(keyPaths(node).map(p => p[0] as string))
      if (node.fields !== undefined) {
        for (const name of Object.keys(node.fields)) {
          if (heads.has(name)) {
            throw new Error(
              `weft rel: pure recomputes key field '${name}' — that is a new identity, not an edit`,
            )
          }
        }
      }
      if (node.pick !== undefined) {
        for (const head of heads) {
          if (!node.pick.includes(head)) {
            throw new Error(
              `weft rel: pure picks away key field '${head}' — a row would lose its identity`,
            )
          }
        }
      }
      return
    }
    case 'join': {
      checkNode(node.left)
      checkNode(node.right)
      if (node.on.length === 0) throw new Error('weft rel: join declares no on-keys')
      if (node.as.length === 0) throw new Error('weft rel: join declares no alias')
      return
    }
  }
}

/** The equi-key a row stands under, for one side of a join. */
export const onKeyOf = (
  pairs: ReadonlyArray<{ left: string; right: string }>,
  side: 'left' | 'right',
  row: Row,
): string => JSON.stringify(pairs.map(p => row[p[side]] ?? null))

/** The merged row of a pair; the phantom of a keeping row stands with null. */
export const mergedRow = (node: JoinNode, left: Row, right: Row | null): Row => ({
  ...left,
  [node.as]: right,
})

export const passesResidual = (node: JoinNode, merged: Row): boolean =>
  node.residual === undefined
    ? true
    : isExpr(node.residual)
      ? truthy(node.residual, merged)
      : node.residual(merged) === true

/** The oracle: the whole answer, recounted from the sources. */
export function recount(
  node: RelNode,
  sources: Record<string, ReadonlyMap<Key, Row>>,
): Map<Key, Row> {
  switch (node.prim) {
    case 'source': {
      const held = sources[node.source]
      if (held === undefined) throw new Error(`weft rel: unknown source '${node.source}'`)
      return new Map(held)
    }
    case 'filter': {
      const out = new Map<Key, Row>()
      for (const [key, row] of recount(node.input, sources)) {
        if (passesFilter(node, row)) out.set(key, row)
      }
      return out
    }
    case 'pure': {
      const out = new Map<Key, Row>()
      for (const [key, row] of recount(node.input, sources)) out.set(key, pureRow(node, row))
      return out
    }
    case 'join': {
      const left = recount(node.left, sources)
      const right = recount(node.right, sources)
      const rightByOn = new Map<string, Row[]>()
      for (const row of right.values()) {
        const at = onKeyOf(node.on, 'right', row)
        const held = rightByOn.get(at)
        if (held === undefined) rightByOn.set(at, [row])
        else held.push(row)
      }
      const out = new Map<Key, Row>()
      for (const leftRow of left.values()) {
        let matched = 0
        for (const rightRow of rightByOn.get(onKeyOf(node.on, 'left', leftRow)) ?? []) {
          const pair = mergedRow(node, leftRow, rightRow)
          if (!passesResidual(node, pair)) continue
          matched++
          out.set(keyOfRow(node, pair), pair)
        }
        if (matched === 0 && node.keeping === true) {
          const alone = mergedRow(node, leftRow, null)
          out.set(keyOfRow(node, alone), alone)
        }
      }
      return out
    }
  }
}

/** Why this row: the source rows it came from, found by descent, stored
 *  nowhere. A join splits its composite key back into its parents'; a keeping
 *  phantom, whose right half is all null, names only its left parent. */
export function whyRow(node: RelNode, key: Key): Array<{ source: string; key: Key }> {
  switch (node.prim) {
    case 'source':
      return [{ source: node.source, key }]
    case 'filter':
    case 'pure':
      return whyRow(node.input, key)
    case 'join': {
      const values = JSON.parse(key as string) as unknown[]
      const split = keyPaths(node.left).length
      const leftWhy = whyRow(node.left, recomposeKey(node.left, values.slice(0, split)))
      const rightValues = values.slice(split)
      if (node.keeping === true && rightValues.every(v => v === null)) return leftWhy
      return [...leftWhy, ...whyRow(node.right, recomposeKey(node.right, rightValues))]
    }
  }
}
