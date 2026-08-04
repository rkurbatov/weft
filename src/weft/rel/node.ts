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

import { canonExpr, evalExpr, paramsOfExpr, substituteExpr, truthy } from './expr.ts'
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

export type FoldDecl =
  | { fold: 'count' }
  | { fold: 'sum'; of: Expr | RowFn }
  | { fold: 'min'; of: Expr | RowFn }
  | { fold: 'max'; of: Expr | RowFn }
  /** The group gathered into an array, ordered by row key — the one order two
   *  implementations can agree on. The inverse of a future expand. */
  | { fold: 'collect'; of?: Expr | RowFn; by?: ReadonlyArray<{ field: string; down?: boolean }> }
  /** The escape hatch: a passport of closures. Non-canonical by nature. */
  | {
      fold: 'custom'
      zero: unknown
      add: (acc: unknown, row: Row) => unknown
      sub?: (acc: unknown, row: Row) => unknown
      join?: (a: unknown, b: unknown) => unknown
    }

export interface AggNode {
  prim: 'agg'
  input: RelNode
  /** Group keys: top-level fields of the input row. Empty folds the whole
   *  table into one row, which then exists even over an empty input. */
  by: readonly string[]
  /** Named folds; each name becomes an output field beside the by-fields. */
  folds: Record<string, FoldDecl>
}

export interface UnionNode {
  prim: 'union'
  left: RelNode
  right: RelNode
}

export interface ExpandNode {
  prim: 'expand'
  input: RelNode
  /** The field holding a nested table — an array of rows. It is consumed:
   *  the expanded rows carry every other parent field, not the table itself. */
  field: string
  /** The nested row lands under this name, as a join's right side does. */
  as: string
  /** Key fields inside a nested row; with the parent's key they are the
   *  expanded row's identity. Two nested rows under one parent must differ. */
  key: readonly string[]
}

export interface ScanNode {
  prim: 'scan'
  input: RelNode
  /** The order the pass follows: fields, each ascending or descending. */
  order: ReadonlyArray<{ field: string; down?: boolean }>
  /** What each row contributes to the carry. */
  step: Expr | RowFn
  /** A field to write the carry BEFORE this row into. Optional on purpose:
   *  a scan always answers `offsetOf`/`at` through its view, and writing the
   *  number into every row is a separate, and often wrong, request — see the
   *  plan's `form`. */
  as?: string
  /** The carry including this row, when the screen wants both ends. */
  through?: string
  /** Where the pass starts. */
  from?: number
}

export type RelNode =
  | SourceNode
  | PureNode
  | FilterNode
  | JoinNode
  | AggNode
  | UnionNode
  | ExpandNode
  | ScanNode

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
export const agg = (
  input: RelNode,
  attrs: { by: readonly string[]; folds: Record<string, FoldDecl> },
): AggNode => ({ prim: 'agg', input, ...attrs })
export const union = (left: RelNode, right: RelNode): UnionNode => ({
  prim: 'union',
  left,
  right,
})
export const scan = (
  input: RelNode,
  attrs: {
    order: ReadonlyArray<{ field: string; down?: boolean }>
    step: Expr | RowFn
    as?: string
    through?: string
    from?: number
  },
): ScanNode => ({ prim: 'scan', input, ...attrs })
export const expand = (
  input: RelNode,
  attrs: { field: string; as: string; key: readonly string[] },
): ExpandNode => ({ prim: 'expand', input, ...attrs })
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
    case 'scan':
      return keyPaths(node.input)
    case 'join':
      return [...keyPaths(node.left), ...keyPaths(node.right).map(p => [node.as].concat(p))]
    case 'agg':
      return node.by.map(f => [f])
    case 'union':
      return keyPaths(node.left)
    case 'expand':
      return [...keyPaths(node.input), ...node.key.map(k => [node.as, k])]
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
  // Zero paths is the whole-table fold: one row, one constant key.
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
    case 'agg': {
      const under = canonNode(node.input)
      if (under === null) return null
      const parts: string[] = []
      for (const [name, decl] of Object.entries(node.folds).toSorted(([a], [b]) =>
        a < b ? -1 : 1,
      )) {
        if (decl.fold === 'custom') return null
        if (decl.fold === 'count') parts.push(`${name}=(count)`)
        else if (decl.fold === 'collect' && decl.of === undefined) {
          const by =
            decl.by === undefined
              ? ''
              : ` by=${decl.by.map(o => `${o.down === true ? '-' : '+'}${o.field}`).join(',')}`
          parts.push(`${name}=(collect${by})`)
        } else {
          const of = decl.of as Expr | RowFn
          if (!isExpr(of)) return null
          parts.push(`${name}=(${decl.fold} ${canonExpr(of)})`)
        }
      }
      return `(agg by=${node.by.join(',')} {${parts.join(' ')}} ${under})`
    }
    case 'union': {
      const left = canonNode(node.left)
      const right = canonNode(node.right)
      if (left === null || right === null) return null
      return `(union ${left} ${right})`
    }
    case 'scan': {
      const under = canonNode(node.input)
      if (under === null || !isExpr(node.step)) return null
      const order = node.order.map(o => `${o.down === true ? '-' : '+'}${o.field}`).join(',')
      const as = node.as === undefined ? '' : ` as=${node.as}`
      const through = node.through === undefined ? '' : ` through=${node.through}`
      const from = node.from === undefined ? '' : ` from=${node.from}`
      return `(scan by=${order} step=${canonExpr(node.step)}${as}${through}${from} ${under})`
    }
    case 'expand': {
      const under = canonNode(node.input)
      if (under === null) return null
      return `(expand .${node.field} as=${node.as} key=${node.key.join(',')} ${under})`
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
    case 'scan': {
      checkNode(node.input)
      if (node.order.length === 0) throw new Error('weft rel: scan declares no order')
      for (const path of keyPaths(node)) {
        const head = path[0] as string
        if (head === node.as || head === node.through) {
          throw new Error(`weft rel: scan writes over key field '${head}'`)
        }
      }
      return
    }
    case 'union': {
      checkNode(node.left)
      checkNode(node.right)
      const left = JSON.stringify(keyPaths(node.left))
      const right = JSON.stringify(keyPaths(node.right))
      if (left !== right) {
        throw new Error(`weft rel: union sides key differently — ${left} against ${right}`)
      }
      return
    }
    case 'expand': {
      checkNode(node.input)
      if (node.field.length === 0) throw new Error('weft rel: expand names no field')
      if (node.as.length === 0) throw new Error('weft rel: expand declares no alias')
      if (node.key.length === 0) throw new Error('weft rel: expand declares no nested key')
      return
    }
    case 'agg': {
      checkNode(node.input)
      if (Object.keys(node.folds).length === 0) throw new Error('weft rel: agg declares no folds')
      for (const name of Object.keys(node.folds)) {
        if (node.by.includes(name)) {
          throw new Error(`weft rel: agg fold '${name}' collides with a by-field of the same name`)
        }
      }
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

export const foldOf = (decl: FoldDecl, row: Row): unknown => {
  if (decl.fold === 'count' || decl.fold === 'custom') return undefined
  if (decl.fold === 'collect' && decl.of === undefined) return undefined
  const of = decl.of as Expr | RowFn
  return isExpr(of) ? evalExpr(of, row) : of(row)
}

/** One fold's answer over one group, recounted — the floor every carrier is
 *  measured against. `collect` and `custom` walk rows by key order, the one
 *  order two implementations can agree on. */
export function foldOne(decl: FoldDecl, rows: ReadonlyMap<Key, Row>): unknown {
  switch (decl.fold) {
    case 'count':
      return rows.size
    case 'sum': {
      let sum = 0
      for (const row of rows.values()) sum += foldOf(decl, row) as number
      return sum
    }
    case 'min':
    case 'max': {
      let best: unknown = null
      for (const row of rows.values()) {
        const v = foldOf(decl, row)
        if (best === null) best = v
        else if (
          decl.fold === 'min' ? (v as number) < (best as number) : (v as number) > (best as number)
        ) {
          best = v
        }
      }
      return best
    }
    case 'collect': {
      const order = decl.by
      const byKey = [...rows.keys()].toSorted((a, b) => {
        if (order !== undefined) {
          const moved = orderCompare(order, rows.get(a) as Row, rows.get(b) as Row)
          if (moved !== 0) return moved
        }
        return String(a) < String(b) ? -1 : 1
      })
      return byKey.map(k => {
        const row = rows.get(k) as Row
        return decl.of === undefined ? row : foldOf(decl, row)
      })
    }
    case 'custom': {
      const byKey = [...rows.keys()].toSorted((a, b) => (String(a) < String(b) ? -1 : 1))
      let acc = decl.zero
      for (const k of byKey) acc = decl.add(acc, rows.get(k) as Row)
      return acc
    }
  }
}

/** One group's whole answer: the by-fields plus every fold. */
export function foldGroup(
  node: AggNode,
  rows: ReadonlyMap<Key, Row>,
  groupValues: readonly unknown[],
): Row {
  const out: Row = {}
  node.by.forEach((f, i) => (out[f] = groupValues[i]))
  for (const [name, decl] of Object.entries(node.folds)) out[name] = foldOne(decl, rows)
  return out
}

/** One parent row unfolded: its other fields plus the nested row under the
 *  alias. A field that is not an array unfolds into nothing. */
export function expandRows(node: ExpandNode, row: Row): Row[] {
  const nested = row[node.field]
  if (!Array.isArray(nested)) return []
  const { [node.field]: _gone, ...rest } = row
  // oxlint-disable-next-line no-map-spread -- each expanded row must be its own object: they land in a table as distinct rows
  return (nested as Row[]).map(inner => ({ ...rest, [node.as]: inner }))
}

/** The values a row files under — the group it belongs to. */
export const groupOf = (node: AggNode, row: Row): unknown[] => node.by.map(f => row[f] ?? null)

/** The comparison a scan's order declares. */
export function orderCompare(
  order: ReadonlyArray<{ field: string; down?: boolean }>,
  a: Row,
  b: Row,
): number {
  for (const { field: f, down } of order) {
    const l = a[f]
    const r = b[f]
    if (l === r) continue
    const less = (l as number) < (r as number)
    return (less ? -1 : 1) * (down === true ? -1 : 1)
  }
  return 0
}

export const stepOf = (node: ScanNode, row: Row): number =>
  (isExpr(node.step) ? evalExpr(node.step, row) : node.step(row)) as number

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
    case 'agg': {
      const under = recount(node.input, sources)
      const groups = new Map<Key, { values: unknown[]; rows: Map<Key, Row> }>()
      for (const [key, row] of under) {
        const values = groupOf(node, row)
        const at = JSON.stringify(values)
        let held = groups.get(at)
        if (held === undefined) {
          held = { values, rows: new Map() }
          groups.set(at, held)
        }
        held.rows.set(key, row)
      }
      const out = new Map<Key, Row>()
      for (const { values, rows } of groups.values()) {
        const row = foldGroup(node, rows, values)
        out.set(keyOfRow(node, row), row)
      }
      // The whole-table fold exists even over nothing.
      if (node.by.length === 0 && out.size === 0) {
        const empty = foldGroup(node, new Map(), [])
        out.set(keyOfRow(node, empty), empty)
      }
      return out
    }
    case 'scan': {
      const under = [...recount(node.input, sources)]
      // Ties are broken by key, so two implementations agree on the order.
      under.sort(
        ([ka, a], [kb, b]) => orderCompare(node.order, a, b) || (String(ka) < String(kb) ? -1 : 1),
      )
      const out = new Map<Key, Row>()
      let carry = node.from ?? 0
      for (const [key, row] of under) {
        const before = carry
        carry += stepOf(node, row)
        if (node.as === undefined && node.through === undefined) {
          out.set(key, row)
          continue
        }
        const marked: Row = { ...row }
        if (node.as !== undefined) marked[node.as] = before
        if (node.through !== undefined) marked[node.through] = carry
        out.set(key, marked)
      }
      return out
    }
    case 'union': {
      const out = recount(node.left, sources)
      for (const [key, row] of recount(node.right, sources)) {
        if (out.has(key)) {
          throw new Error(
            `weft rel: union key collision on ${String(key)} — sides must be disjoint`,
          )
        }
        out.set(key, row)
      }
      return out
    }
    case 'expand': {
      const out = new Map<Key, Row>()
      for (const row of recount(node.input, sources).values()) {
        for (const opened of expandRows(node, row)) {
          const key = keyOfRow(node, opened)
          if (out.has(key)) {
            throw new Error(
              `weft rel: expand key collision on ${String(key)} — nested rows must differ`,
            )
          }
          out.set(key, opened)
        }
      }
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

const subExpr = <E extends Expr | RowFn>(e: E, values: ReadonlyMap<string, unknown>): E =>
  (isExpr(e) ? substituteExpr(e, values) : e) as E

const subFold = (decl: FoldDecl, values: ReadonlyMap<string, unknown>): FoldDecl => {
  if (decl.fold === 'count' || decl.fold === 'custom') return decl
  if (decl.of === undefined) return decl
  return { ...decl, of: subExpr(decl.of, values) }
}

/** The same tree with every hole filled — what actually runs; the original,
 *  holes and all, stays the tree's identity. */
export function substituteNode(node: RelNode, values: ReadonlyMap<string, unknown>): RelNode {
  switch (node.prim) {
    case 'source':
      return node
    case 'filter':
      return {
        ...node,
        input: substituteNode(node.input, values),
        test: subExpr(node.test, values),
      }
    case 'pure': {
      const out: PureNode = { ...node, input: substituteNode(node.input, values) }
      if (node.fields !== undefined) {
        const fields: Record<string, Expr | RowFn> = {}
        for (const [name, e] of Object.entries(node.fields)) fields[name] = subExpr(e, values)
        out.fields = fields
      }
      return out
    }
    case 'join': {
      const out: JoinNode = {
        ...node,
        left: substituteNode(node.left, values),
        right: substituteNode(node.right, values),
      }
      if (node.residual !== undefined) out.residual = subExpr(node.residual, values)
      return out
    }
    case 'agg': {
      const folds: Record<string, FoldDecl> = {}
      for (const [name, decl] of Object.entries(node.folds)) folds[name] = subFold(decl, values)
      return { ...node, input: substituteNode(node.input, values), folds }
    }
    case 'union':
      return {
        ...node,
        left: substituteNode(node.left, values),
        right: substituteNode(node.right, values),
      }
    case 'expand':
      return { ...node, input: substituteNode(node.input, values) }
    case 'scan':
      return {
        ...node,
        input: substituteNode(node.input, values),
        step: subExpr(node.step, values),
      }
  }
}

const paramsOfE = (e: Expr | RowFn, out: Set<string>): void => {
  if (isExpr(e)) paramsOfExpr(e, out)
}

/** Every hole under a node, by name. */
export function paramsOfNode(node: RelNode, out: Set<string> = new Set()): Set<string> {
  switch (node.prim) {
    case 'source':
      return out
    case 'filter':
      paramsOfE(node.test, out)
      return paramsOfNode(node.input, out)
    case 'pure':
      for (const e of Object.values(node.fields ?? {})) paramsOfE(e, out)
      return paramsOfNode(node.input, out)
    case 'join':
      if (node.residual !== undefined) paramsOfE(node.residual, out)
      paramsOfNode(node.left, out)
      return paramsOfNode(node.right, out)
    case 'agg':
      for (const decl of Object.values(node.folds)) {
        if (decl.fold !== 'count' && decl.fold !== 'custom' && decl.of !== undefined) {
          paramsOfE(decl.of, out)
        }
      }
      return paramsOfNode(node.input, out)
    case 'union':
      paramsOfNode(node.left, out)
      return paramsOfNode(node.right, out)
    case 'expand':
      return paramsOfNode(node.input, out)
    case 'scan':
      paramsOfE(node.step, out)
      return paramsOfNode(node.input, out)
  }
}

/** Why this row: the source rows it came from, found by descent, stored
 *  nowhere. A join splits its composite key back into its parents'; a keeping
 *  phantom, whose right half is all null, names only its left parent. */
export function whyRow(
  node: RelNode,
  key: Key,
  sources: Record<string, ReadonlyMap<Key, Row>>,
): Array<{ source: string; key: Key }> {
  switch (node.prim) {
    case 'source':
      return [{ source: node.source, key }]
    case 'filter':
    case 'pure':
    case 'scan':
      return whyRow(node.input, key, sources)
    case 'join': {
      const values = JSON.parse(key as string) as unknown[]
      const split = keyPaths(node.left).length
      const leftWhy = whyRow(node.left, recomposeKey(node.left, values.slice(0, split)), sources)
      const rightValues = values.slice(split)
      if (node.keeping === true && rightValues.every(v => v === null)) return leftWhy
      return [...leftWhy, ...whyRow(node.right, recomposeKey(node.right, rightValues), sources)]
    }
    case 'union':
      return recount(node.left, sources).has(key)
        ? whyRow(node.left, key, sources)
        : whyRow(node.right, key, sources)
    case 'expand': {
      // The nested rows are not source rows of their own: the whole expanded
      // row came from its parent, so the parent's provenance is the answer.
      const values = JSON.parse(key as string) as unknown[]
      const split = keyPaths(node.input).length
      return whyRow(node.input, recomposeKey(node.input, values.slice(0, split)), sources)
    }
    case 'agg': {
      // A group names its members; the members are found when asked, kept
      // nowhere: the input is recounted and sifted by the group's values.
      const wanted =
        node.by.length === 1 ? JSON.stringify([key]) : node.by.length === 0 ? '[]' : (key as string)
      const out: Array<{ source: string; key: Key }> = []
      for (const [underKey, row] of recount(node.input, sources)) {
        if (JSON.stringify(groupOf(node, row)) !== wanted) continue
        out.push(...whyRow(node.input, underKey, sources))
      }
      return out
    }
  }
}
