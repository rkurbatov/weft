// Grouping with declared folds, kept incrementally.
//
// A carrier is chosen per fold through the same door the table uses: a fold
// with an inverse runs as a running total, one without is recounted over its
// own group — not over the whole collection.

import { alike } from '../../table/table.ts'
import type { Change, Key } from '../../table/table.ts'
import { planFold } from '../../table/plan.ts'

import type { Row } from '../expr.ts'
import { foldOf, foldOne, groupOf, keyOfRow } from '../node.ts'
import type { AggNode, FoldDecl } from '../node.ts'
import type { Make, Runner } from './runner.ts'

/** Can one row be taken back out of the answer? Then the fold runs. */
const invertible = (decl: FoldDecl): boolean =>
  decl.fold === 'count' || decl.fold === 'sum' || (decl.fold === 'custom' && decl.sub !== undefined)

const accAdd = (decl: FoldDecl, acc: unknown, row: Row): unknown => {
  if (decl.fold === 'count') return (acc as number) + 1
  if (decl.fold === 'sum') return (acc as number) + (foldOf(decl, row) as number)
  return (decl as { add: (a: unknown, r: Row) => unknown }).add(acc, row)
}

const accSub = (decl: FoldDecl, acc: unknown, row: Row): unknown => {
  if (decl.fold === 'count') return (acc as number) - 1
  if (decl.fold === 'sum') return (acc as number) - (foldOf(decl, row) as number)
  return (decl as { sub: (a: unknown, r: Row) => unknown }).sub!(acc, row)
}

const accZero = (decl: FoldDecl): unknown => (decl.fold === 'custom' ? decl.zero : 0)

export function aggRunner(node: AggNode, make: Make): Runner {
  const input = make(node.input)
  interface Group {
    values: unknown[]
    rows: Map<Key, Row>
    accs: Map<string, unknown>
  }
  const groups = new Map<string, Group>()
  const lastOut = new Map<Key, Row>()
  const folds = Object.entries(node.folds)

  // The carrier per fold, declared through the same door every fold uses:
  // an inverse runs, anything else recounts its group. A tree per group is
  // a plan for later — plans are free, the announcement is honest today.
  const running = new Map<string, boolean>()
  for (const [name, decl] of folds) {
    const runs = invertible(decl)
    const plan = planFold(`agg.${name}`, {
      size: 0,
      hasSub: runs,
      hasJoin: decl.fold === 'custom' ? decl.join !== undefined : false,
      forced: runs ? 'running' : 'recount',
    })
    running.set(name, plan.carrier === 'running')
  }

  const groupFor = (values: unknown[]): Group => {
    const at = JSON.stringify(values)
    let held = groups.get(at)
    if (held === undefined) {
      held = { values, rows: new Map(), accs: new Map() }
      for (const [name, decl] of folds) {
        if (running.get(name) === true) held.accs.set(name, accZero(decl))
      }
      groups.set(at, held)
    }
    return held
  }

  /** One group's current answer: running folds from their accumulators, the
   *  rest recounted over the group — never over the collection. */
  const rowOf = (group: Group): Row => {
    const out: Row = {}
    node.by.forEach((f, i) => (out[f] = group.values[i]))
    for (const [name, decl] of folds) {
      out[name] = running.get(name) === true ? group.accs.get(name) : foldOne(decl, group.rows)
    }
    return out
  }

  const seed = (under: ReadonlyMap<Key, Row>): void => {
    groups.clear()
    lastOut.clear()
    for (const [key, row] of under) {
      const group = groupFor(groupOf(node, row))
      group.rows.set(key, row)
      for (const [name, decl] of folds) {
        if (running.get(name) === true)
          group.accs.set(name, accAdd(decl, group.accs.get(name), row))
      }
    }
    if (node.by.length === 0) groupFor([])
  }

  return {
    feed(from, changes) {
      const touched = new Set<string>()
      for (const change of input.feed(from, changes)) {
        if (change.prev !== undefined) {
          const at = JSON.stringify(groupOf(node, change.prev))
          const group = groups.get(at)
          if (group !== undefined) {
            group.rows.delete(change.key)
            for (const [name, decl] of folds) {
              if (running.get(name) === true) {
                group.accs.set(name, accSub(decl, group.accs.get(name), change.prev))
              }
            }
            touched.add(at)
          }
        }
        if (change.next !== undefined) {
          const group = groupFor(groupOf(node, change.next))
          group.rows.set(change.key, change.next)
          for (const [name, decl] of folds) {
            if (running.get(name) === true) {
              group.accs.set(name, accAdd(decl, group.accs.get(name), change.next))
            }
          }
          touched.add(JSON.stringify(group.values))
        }
      }
      const out: Change<Row>[] = []
      for (const at of touched) {
        const group = groups.get(at)
        if (group === undefined) continue
        const alive = group.rows.size > 0 || node.by.length === 0
        const row = alive ? rowOf(group) : undefined
        const key = alive ? keyOfRow(node, row as Row) : keyOfRow(node, dressKey(group.values))
        const prev = lastOut.get(key)
        if (!alive) {
          groups.delete(at)
          if (prev !== undefined) {
            lastOut.delete(key)
            out.push({ key, prev })
          }
          continue
        }
        if (prev !== undefined && alike(prev, row)) continue
        lastOut.set(key, row as Row)
        out.push({ key, ...(prev === undefined ? {} : { prev }), next: row as Row })
      }
      return out
    },
    rebuild(sources) {
      seed(input.rebuild(sources))
      const out = new Map<Key, Row>()
      for (const group of groups.values()) {
        if (group.rows.size === 0 && node.by.length > 0) continue
        const row = rowOf(group)
        const key = keyOfRow(node, row)
        out.set(key, row)
        lastOut.set(key, row)
      }
      return out
    },
  }

  /** A dead group still has to name its key to be dropped. */
  function dressKey(values: unknown[]): Row {
    const out: Row = {}
    node.by.forEach((f, i) => (out[f] = values[i]))
    return out
  }
}
