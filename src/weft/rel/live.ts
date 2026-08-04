// The tree, running: sources in, a live table out, changes travelling by each
// primitive's own derivative rule — a filtered edit costs the edit, a join
// edit costs its partners, never the collection. Each node gets a runner;
// stateless ones (filter, pure) map changes through, stateful ones (join)
// keep the indexes their derivative needs. The output is an ordinary engine
// table, so views, folds and subscribers work on it unchanged, and demand
// flows through it: the first watcher downstream starts the following, the
// last one leaving stops it. A follower that fell too far behind resyncs
// from the oracle's recount — the naive answer is the floor, here quite
// literally the fallback.
//
// A join is bilinear, and the order of application is the whole trick: a
// batch is pushed through the left side against the right index as it was,
// then through the right side against the left index as it now is — that is
// dA⋈B + (A+dA)⋈dB, which sums to exactly the derivative, self-joins
// included, with no pair counted twice.

import { untracked, watch } from '../core/graph/graph.ts'
import type { Watchable } from '../core/graph/graph.ts'
import { table, feedOf, follow } from '../core/table/table.ts'
import type { Table, Change, Patch, Key } from '../core/table/table.ts'
import { alike } from '../core/table/table.ts'
import { planFold } from '../core/table/plan.ts'
import {
  checkNode,
  canonNode,
  expandRows,
  foldOf,
  foldOne,
  groupOf,
  keyOfRow,
  mergedRow,
  onKeyOf,
  passesFilter,
  passesResidual,
  paramsOfNode,
  pureRow,
  recount,
  substituteNode,
  whyRow,
} from './node.ts'
import type { AggNode, FoldDecl, JoinNode, RelNode } from './node.ts'
import type { Row } from './expr.ts'

export interface Relation extends Table<Row> {
  /** The source rows a key came from — found by descent when asked. */
  why(key: Key): Array<{ source: string; key: Key }>
  /** The tree's canonical form, or null when a closure stands inside. */
  readonly canon: string | null
}

export interface RelateOptions {
  name?: string
  /** Values for the tree's ?holes — ordinary cells; a change substitutes and
   *  rebuilds, and subscribers still hear only the difference, because a
   *  replace gates equal rows. A rebuild per change is the naive floor;
   *  a plan that re-judges in place may replace it without touching this. */
  params?: Record<string, Watchable<unknown>>
}

type Sources = Record<string, ReadonlyMap<Key, Row>>

/** One node, running: state where the derivative needs it. */
interface Runner {
  /** Changes from one source pushed through; out come this node's changes. */
  feed(from: string, changes: readonly Change<Row>[]): Change<Row>[]
  /** The whole answer anew; resets whatever state the node keeps. */
  rebuild(sources: Sources): Map<Key, Row>
}

function runnerFor(node: RelNode): Runner {
  switch (node.prim) {
    case 'source':
      return {
        feed: (from, changes) => (node.source === from ? [...changes] : []),
        rebuild: sources => recount(node, sources),
      }
    case 'filter': {
      const input = runnerFor(node.input)
      return {
        feed(from, changes) {
          const out: Change<Row>[] = []
          for (const under of input.feed(from, changes)) {
            const prev =
              under.prev !== undefined && passesFilter(node, under.prev) ? under.prev : undefined
            const next =
              under.next !== undefined && passesFilter(node, under.next) ? under.next : undefined
            if (prev === undefined && next === undefined) continue
            out.push({
              key: under.key,
              ...(prev === undefined ? {} : { prev }),
              ...(next === undefined ? {} : { next }),
            })
          }
          return out
        },
        rebuild: sources => recount(node, sources),
      }
    }
    case 'pure': {
      const input = runnerFor(node.input)
      return {
        feed(from, changes) {
          const out: Change<Row>[] = []
          for (const under of input.feed(from, changes)) {
            out.push({
              key: under.key,
              ...(under.prev === undefined ? {} : { prev: pureRow(node, under.prev) }),
              ...(under.next === undefined ? {} : { next: pureRow(node, under.next) }),
            })
          }
          return out
        },
        rebuild: sources => recount(node, sources),
      }
    }
    case 'join':
      return joinRunner(node)
    case 'agg':
      return aggRunner(node)
    case 'union': {
      const left = runnerFor(node.left)
      const right = runnerFor(node.right)
      // Which side holds a key: 1 left, 2 right. Both at once is the error
      // the corpus promises — outside a cycle, sides must be disjoint.
      const side = new Map<Key, number>()
      const land = (changes: Change<Row>[], bit: number): Change<Row>[] => {
        for (const change of changes) {
          if (change.prev !== undefined && change.next === undefined) {
            const held = (side.get(change.key) ?? 0) & ~bit
            if (held === 0) side.delete(change.key)
            else side.set(change.key, held)
          } else if (change.prev === undefined && change.next !== undefined) {
            const held = (side.get(change.key) ?? 0) | bit
            if (held === 3) {
              throw new Error(
                `weft rel: union key collision on ${String(change.key)} — sides must be disjoint`,
              )
            }
            side.set(change.key, held)
          }
        }
        return changes
      }
      return {
        feed(from, changes) {
          return [...land(left.feed(from, changes), 1), ...land(right.feed(from, changes), 2)]
        },
        rebuild(sources) {
          side.clear()
          const out = left.rebuild(sources)
          for (const key of out.keys()) side.set(key, 1)
          for (const [key, row] of right.rebuild(sources)) {
            if (side.has(key)) {
              throw new Error(
                `weft rel: union key collision on ${String(key)} — sides must be disjoint`,
              )
            }
            side.set(key, 2)
            out.set(key, row)
          }
          return out
        },
      }
    }
    case 'expand': {
      const input = runnerFor(node.input)
      // Stateless: a parent row alone says what it unfolds into, so a change
      // is the diff of its two unfoldings, by expanded key.
      const opened = (row: Row | undefined): Map<Key, Row> => {
        const out = new Map<Key, Row>()
        if (row === undefined) return out
        for (const one of expandRows(node, row)) {
          const key = keyOfRow(node, one)
          if (out.has(key)) {
            throw new Error(
              `weft rel: expand key collision on ${String(key)} — nested rows must differ`,
            )
          }
          out.set(key, one)
        }
        return out
      }
      return {
        feed(from, changes) {
          const out = new Map<Key, Change<Row>>()
          for (const change of input.feed(from, changes)) {
            diffInto(out, opened(change.prev), opened(change.next))
          }
          return [...out.values()].filter(c => c.prev !== undefined || c.next !== undefined)
        },
        rebuild(sources) {
          return recount(node, sources)
        },
      }
    }
  }
}

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

function aggRunner(node: AggNode): Runner {
  const input = runnerFor(node.input)
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

type OnIndex = Map<string, Map<Key, Row>>

const put = (index: OnIndex, at: string, key: Key, row: Row): void => {
  let held = index.get(at)
  if (held === undefined) {
    held = new Map()
    index.set(at, held)
  }
  held.set(key, row)
}

const cut = (index: OnIndex, at: string, key: Key): void => {
  const held = index.get(at)
  if (held === undefined) return
  held.delete(key)
  if (held.size === 0) index.delete(at)
}

const diffInto = (
  out: Map<Key, Change<Row>>,
  before: Map<Key, Row>,
  after: Map<Key, Row>,
): void => {
  const land = (key: Key, prev: Row | undefined, next: Row | undefined): void => {
    const held = out.get(key)
    const first = held === undefined ? prev : held.prev
    out.set(key, {
      key,
      ...(first === undefined ? {} : { prev: first }),
      ...(next === undefined ? {} : { next }),
    })
  }
  for (const [key, prev] of before) if (!after.has(key)) land(key, prev, undefined)
  for (const [key, next] of after) land(key, before.get(key), next)
}

function joinRunner(node: JoinNode): Runner {
  const left = runnerFor(node.left)
  const right = runnerFor(node.right)
  // The indexes the derivative needs: each side's rows, grouped by equi-key.
  const leftByOn: OnIndex = new Map()
  const rightByOn: OnIndex = new Map()
  const leftKeyOf = (row: Row): Key => keyOfRow(node.left, row)
  const rightKeyOf = (row: Row): Key => keyOfRow(node.right, row)

  /** Everything one left row stands for right now: its pairs, or its phantom. */
  const outsOf = (leftRow: Row): Map<Key, Row> => {
    const out = new Map<Key, Row>()
    for (const rightRow of rightByOn.get(onKeyOf(node.on, 'left', leftRow))?.values() ?? []) {
      const pair = mergedRow(node, leftRow, rightRow)
      if (!passesResidual(node, pair)) continue
      out.set(keyOfRow(node, pair), pair)
    }
    if (out.size === 0 && node.keeping === true) {
      const alone = mergedRow(node, leftRow, null)
      out.set(keyOfRow(node, alone), alone)
    }
    return out
  }

  const applyLeft = (out: Map<Key, Change<Row>>, change: Change<Row>): void => {
    const before = change.prev === undefined ? new Map<Key, Row>() : outsOf(change.prev)
    if (change.prev !== undefined) {
      cut(leftByOn, onKeyOf(node.on, 'left', change.prev), change.key)
    }
    if (change.next !== undefined) {
      put(leftByOn, onKeyOf(node.on, 'left', change.next), change.key, change.next)
    }
    const after = change.next === undefined ? new Map<Key, Row>() : outsOf(change.next)
    diffInto(out, before, after)
  }

  const applyRight = (out: Map<Key, Change<Row>>, change: Change<Row>): void => {
    // The left rows this change can touch: the partners of its old and new keys.
    const touched = new Map<Key, Row>()
    for (const side of [change.prev, change.next]) {
      if (side === undefined) continue
      for (const [key, row] of leftByOn.get(onKeyOf(node.on, 'right', side)) ?? []) {
        touched.set(key, row)
      }
    }
    const before = new Map<Key, Map<Key, Row>>()
    for (const [key, row] of touched) before.set(key, outsOf(row))
    if (change.prev !== undefined) {
      cut(rightByOn, onKeyOf(node.on, 'right', change.prev), change.key)
    }
    if (change.next !== undefined) {
      put(rightByOn, onKeyOf(node.on, 'right', change.next), change.key, change.next)
    }
    for (const [key, row] of touched) {
      diffInto(out, before.get(key) as Map<Key, Row>, outsOf(row))
    }
  }

  return {
    feed(from, changes) {
      // Left against the right index as it was, then right against the left
      // index as it now is — the bilinear derivative, in that order.
      const leftIn = left.feed(from, changes)
      const rightIn = right.feed(from, changes)
      const out = new Map<Key, Change<Row>>()
      for (const change of leftIn) applyLeft(out, change)
      for (const change of rightIn) applyRight(out, change)
      const landed: Change<Row>[] = []
      for (const change of out.values()) {
        if (change.prev === undefined && change.next === undefined) continue
        landed.push(change)
      }
      return landed
    },
    rebuild(sources) {
      leftByOn.clear()
      rightByOn.clear()
      for (const row of left.rebuild(sources).values()) {
        put(leftByOn, onKeyOf(node.on, 'left', row), leftKeyOf(row), row)
      }
      for (const row of right.rebuild(sources).values()) {
        put(rightByOn, onKeyOf(node.on, 'right', row), rightKeyOf(row), row)
      }
      return recount(node, sources)
    },
  }
}

/** Every source leaf under a node, by name. */
function leaves(node: RelNode, out: Set<string> = new Set()): Set<string> {
  switch (node.prim) {
    case 'source':
      out.add(node.source)
      return out
    case 'filter':
    case 'pure':
    case 'agg':
    case 'expand':
      return leaves(node.input, out)
    case 'join':
    case 'union':
      leaves(node.left, out)
      return leaves(node.right, out)
  }
}

export function relate(
  root: RelNode,
  sources: Record<string, Table<Row>>,
  options: RelateOptions = {},
): Relation {
  checkNode(root)
  const named = [...leaves(root)]
  for (const name of named) {
    if (sources[name] === undefined) throw new Error(`weft rel: source '${name}' is not provided`)
  }
  const name = options.name ?? 'rel'

  const holes = [...paramsOfNode(root)]
  const cells = options.params ?? {}
  for (const hole of holes) {
    if (cells[hole] === undefined) {
      throw new Error(`weft rel: parameter ?${hole} is not provided`)
    }
  }
  const valuesNow = (): Map<string, unknown> => {
    const values = new Map<string, unknown>()
    for (const hole of holes) values.set(hole, (cells[hole] as Watchable<unknown>).get())
    return values
  }

  let resolved = holes.length === 0 ? root : untracked(() => substituteNode(root, valuesNow()))
  let runner = runnerFor(resolved)

  let stops: Array<() => void> = []

  const out = table<Row>({
    name,
    key: row => keyOfRow(root, row),
    onDemand: start,
    onIdle: stop,
  })

  const snapshot = (): Sources => {
    const held: Sources = {}
    for (const sourceName of named) {
      const feed = feedOf(sources[sourceName] as Table<Row>)
      feed.version.peek()
      const rows = new Map<Key, Row>()
      feed.each(row => rows.set(feed.keyOf(row), row))
      held[sourceName] = rows
    }
    return held
  }

  const rebuild = (): void => out.replace(runner.rebuild(snapshot()).values())

  const retune = (): void => {
    resolved = untracked(() => substituteNode(root, valuesNow()))
    runner = runnerFor(resolved)
    rebuild()
  }

  const applyFrom = (from: string, changes: readonly Change<Row>[]): void => {
    const patch: { put: Row[]; drop: Key[] } = { put: [], drop: [] }
    for (const change of runner.feed(from, changes)) {
      if (change.next !== undefined) patch.put.push(change.next)
      else patch.drop.push(change.key)
    }
    if (patch.put.length > 0 || patch.drop.length > 0) out.apply(patch as Patch<Row>)
  }

  function start(): void {
    let built = false
    if (holes.length > 0) {
      let tuned = false
      stops.push(
        watch(() => {
          const values = valuesNow() // reading is the dependency
          if (tuned) {
            void values
            retune()
          }
          tuned = true
        }),
      )
    }
    for (const sourceName of named) {
      const feed = feedOf(sources[sourceName] as Table<Row>)
      const ensure = follow(feed, {
        first() {
          // One rebuild covers every source; the first follower does it.
          if (!built) rebuild()
          built = true
        },
        apply: changes => applyFrom(sourceName, changes),
        resync: rebuild,
      })
      stops.push(watch(() => ensure()))
    }
  }

  function stop(): void {
    for (const halt of stops) halt()
    stops = []
  }

  return {
    ...out,
    why: key => whyRow(resolved, key, snapshot()),
    canon: canonNode(root),
    dispose() {
      stop()
      out.dispose()
    },
  }
}
