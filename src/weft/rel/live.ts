// The tree, running: sources in, a live table out, changes travelling by each
// primitive's own derivative rule — a filtered edit costs the edit, never the
// collection. The output is an ordinary engine table, so views, folds and
// subscribers work on it unchanged, and demand flows through it: the first
// watcher downstream starts the following, the last one leaving stops it.
// A follower that fell too far behind resyncs from the oracle's recount —
// the naive answer is the floor, here quite literally the fallback.

import { watch } from '../core/graph/graph.ts'
import { table, feedOf, follow } from '../core/table/table.ts'
import type { Table, Change, Patch, Key } from '../core/table/table.ts'
import { checkNode, canonNode, keyOfRow, passesFilter, pureRow, recount, whyRow } from './node.ts'
import type { RelNode } from './node.ts'
import type { Row } from './expr.ts'

export interface Relation extends Table<Row> {
  /** The source rows a key came from — found by descent when asked. */
  why(key: Key): Array<{ source: string; key: Key }>
  /** The tree's canonical form, or null when a closure stands inside. */
  readonly canon: string | null
}

export interface RelateOptions {
  name?: string
}

/** Every source leaf under a node, by name. */
function leaves(node: RelNode, out: Set<string> = new Set()): Set<string> {
  switch (node.prim) {
    case 'source':
      out.add(node.source)
      return out
    case 'filter':
    case 'pure':
      return leaves(node.input, out)
  }
}

/** One input change pushed down through the tree; null when it dies inside. */
function throughTree(node: RelNode, from: string, change: Change<Row>): Change<Row> | null {
  switch (node.prim) {
    case 'source':
      return node.source === from ? change : null
    case 'filter': {
      const under = throughTree(node.input, from, change)
      if (under === null) return null
      const prev =
        under.prev !== undefined && passesFilter(node, under.prev) ? under.prev : undefined
      const next =
        under.next !== undefined && passesFilter(node, under.next) ? under.next : undefined
      if (prev === undefined && next === undefined) return null
      return {
        key: under.key,
        ...(prev === undefined ? {} : { prev }),
        ...(next === undefined ? {} : { next }),
      }
    }
    case 'pure': {
      const under = throughTree(node.input, from, change)
      if (under === null) return null
      return {
        key: under.key,
        ...(under.prev === undefined ? {} : { prev: pureRow(node, under.prev) }),
        ...(under.next === undefined ? {} : { next: pureRow(node, under.next) }),
      }
    }
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

  let stops: Array<() => void> = []

  const out = table<Row>({
    name,
    key: row => keyOfRow(root, row),
    onDemand: start,
    onIdle: stop,
  })

  const snapshot = (): Record<string, ReadonlyMap<Key, Row>> => {
    const held: Record<string, ReadonlyMap<Key, Row>> = {}
    for (const sourceName of named) {
      const feed = feedOf(sources[sourceName] as Table<Row>)
      feed.version.peek()
      const rows = new Map<Key, Row>()
      feed.each(row => rows.set(feed.keyOf(row), row))
      held[sourceName] = rows
    }
    return held
  }

  const rebuild = (): void => out.replace(recount(root, snapshot()).values())

  const applyFrom = (from: string, changes: readonly Change<Row>[]): void => {
    const patch: { put: Row[]; drop: Key[] } = { put: [], drop: [] }
    for (const change of changes) {
      const landed = throughTree(root, from, change)
      if (landed === null) continue
      if (landed.next !== undefined) patch.put.push(landed.next)
      else patch.drop.push(keyOfRow(root, landed.prev as Row))
    }
    if (patch.put.length > 0 || patch.drop.length > 0) out.apply(patch as Patch<Row>)
  }

  function start(): void {
    let built = false
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
    why: key => whyRow(root, key),
    canon: canonNode(root),
    dispose() {
      stop()
      out.dispose()
    },
  }
}
