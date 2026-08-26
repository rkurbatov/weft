// The tree, running: sources in, a live table out, changes travelling by each
// primitive's own derivative rule — a filtered edit costs the edit, a join
// edit costs its partners, never the collection. Each node gets a runner;
// stateless ones (filter, pure) map changes through, stateful ones (join)
// keep the indexes their derivative needs. The output is an ordinary engine
// table, so views, folds and subscribers work on it unchanged, and demand
// flows through it: the first watcher downstream starts the following, the
// last one leaving stops it. A follower that fell too far behind resyncs
// from the oracle's oracle — the naive answer is the floor, here quite
// literally the fallback.
//
// A join is bilinear, and the order of application is the whole trick: a
// batch is pushed through the left side against the right index as it was,
// then through the right side against the left index as it now is — that is
// dA⋈B + (A+dA)⋈dB, which sums to exactly the derivative, self-joins
// included, with no pair counted twice.

import { untracked, watch } from '#graph'
import type { Watchable } from '#graph'
import { table, feedOf } from '#table'
import { follow } from '#feed'
import type { Table, Patch } from '#table'
import type { Change } from '#feed'
import type { Key } from '#feed'

import { canonNode, checkNode, keyOfRow, paramsOfNode, substituteNode, whyRow } from './node.ts'
import type { RelNode } from './node.ts'
import type { Row } from './expr.ts'
import { runnerFor } from './runners/index.ts'
import type { Ordering, Runner, Sources } from './runners/index.ts'

export type { Ordering, Runner }

export interface Relation extends Table<Row> {
  /** The source rows a key came from — found by descent when asked. */
  why(key: Key): Array<{ source: string; key: Key }>
  /** When the tree's root is a scan: its ordered view, answering offsets on
   *  demand — what a virtualised list asks a hundred times per scroll,
   *  without a number ever being written into a row. */
  readonly order: Ordering | undefined
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
    case 'scan':
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
  /**
   * The parameters as one comparable line, read without becoming a dependency.
   * Typed, so the number 1 and the string "1" do not read as the same word.
   */
  const appliedNow = (): string =>
    untracked(() =>
      holes
        .map(hole => {
          const value = (cells[hole] as Watchable<unknown>).get()
          return `${typeof value}:${JSON.stringify(value) ?? 'undefined'}`
        })
        .join('\u0000'),
    )

  let resolved = holes.length === 0 ? root : untracked(() => substituteNode(root, valuesNow()))
  let runner = runnerFor(resolved)
  // Which parameters the standing runner was built for. Not a flag: nobody was
  // watching while they changed, so on the way back the question is not "has
  // this run before" but "was it built for these values".
  let tunedFor = holes.length === 0 ? '' : appliedNow()

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
      // The live map, not a copy: a rebuild reads it synchronously and the
      // one runner that needs a mutable map copies at that point. Rebuilding
      // on every parameter change used to allocate a table-sized map first —
      // a letter typed into a search box over a hundred thousand rows paid
      // for a hash table nobody kept.
      held[sourceName] = feed.asMap() as Map<Key, Row>
    }
    return held
  }

  const rebuild = (): void => out.replace(runner.rebuild(snapshot()).values())

  const retune = (): void => {
    resolved = untracked(() => substituteNode(root, valuesNow()))
    runner = runnerFor(resolved)
    tunedFor = appliedNow()
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
      // The first pass only takes the dependency — unless the parameters moved
      // while nobody was looking. A search box typed into during a spell of no
      // demand used to answer, once, with the results of the old word.
      let first = true
      stops.push(
        watch(() => {
          const values = valuesNow() // reading is the dependency
          void values
          if (!first || appliedNow() !== tunedFor) retune()
          first = false
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
    get order(): Ordering | undefined {
      return runner.view
    },
    why: key => whyRow(resolved, key, snapshot()),
    canon: canonNode(root),
    dispose() {
      stop()
      out.dispose()
    },
  }
}
