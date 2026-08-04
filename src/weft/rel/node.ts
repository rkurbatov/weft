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

export type RelNode = SourceNode | PureNode | FilterNode

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

/** The fields a node's key is made of — inherited until a primitive says otherwise. */
export function keyFields(node: RelNode): readonly string[] {
  switch (node.prim) {
    case 'source':
      return node.key
    case 'pure':
    case 'filter':
      return keyFields(node.input)
  }
}

/** A row's key under a node's rule: one field plain, several as a joined form. */
export function keyOfRow(node: RelNode, row: Row): Key {
  const fields = keyFields(node)
  if (fields.length === 1) return row[fields[0] as string] as Key
  return JSON.stringify(fields.map(f => row[f]))
}

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
      const keys = keyFields(node)
      if (node.fields !== undefined) {
        for (const name of Object.keys(node.fields)) {
          if (keys.includes(name)) {
            throw new Error(
              `weft rel: pure recomputes key field '${name}' — that is a new identity, not an edit`,
            )
          }
        }
      }
      if (node.pick !== undefined) {
        for (const f of keys) {
          if (!node.pick.includes(f)) {
            throw new Error(
              `weft rel: pure picks away key field '${f}' — a row would lose its identity`,
            )
          }
        }
      }
      return
    }
  }
}

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
  }
}

/** Why this row: the source rows it came from, found by descent, stored nowhere. */
export function whyRow(node: RelNode, key: Key): Array<{ source: string; key: Key }> {
  switch (node.prim) {
    case 'source':
      return [{ source: node.source, key }]
    case 'filter':
    case 'pure':
      return whyRow(node.input, key)
  }
}
