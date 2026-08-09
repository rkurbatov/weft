// A table: rows with a key, and the live views over them.
//
// The pieces live beside this file — the contract in contract.ts, sameness in
// same.ts, the change log in the feed package, views in views.ts, folds in fold.ts —
// and this one puts them together and hands out the surface.

import { port } from '#graph'
import type { Key } from '#feed'
import { alike } from './same.ts'
import { changeLog, KEEP } from '#feed'
import { tableOver } from './over.ts'
import { remember } from './feeds.ts'
import type { Change, Feed, Patch, SourceTable, TableOptions } from './contract.ts'

export type {
  Change,
  Feed,
  FoldSpec,
  Follower,
  Ordered,
  Patch,
  SourceTable,
  Table,
  TableOptions,
  Key,
} from './contract.ts'
export { alike } from './same.ts'
export { follow } from '#feed'
export { feedOf } from './feeds.ts'

/** The reading surface every table shares, source and derived alike. */
// Engine-internal: the relational layer (#rel) consumes a table's
// changes through its feed instead of diffing snapshots. Not in the front
// door on purpose — a feed's state reads are only valid after reading its
// version, which is a contract for engine code, not for applications.

/**
 * One argument that is a collection, or several that are rows.
 *
 * So that a caller never has to write `put(...rows)`: spreading a large
 * collection into call arguments overflows the stack, and it does so at a size
 * Node survives and a browser does not.
 */
const loose = <T>(given: readonly unknown[]): readonly T[] => {
  const first = given[0]
  if (
    given.length === 1 &&
    typeof first === 'object' &&
    first !== null &&
    Symbol.iterator in (first as object)
  ) {
    return [...(first as Iterable<T>)]
  }
  return given as readonly T[]
}

export function table<R>(options: TableOptions<R>): SourceTable<R> {
  const name = options.name ?? 'table'
  const keyOf = options.key
  const equal = options.equal ?? alike
  const wins = options.wins
  const state = new Map<Key, R>()
  const log = changeLog<R>(options.keep ?? KEEP)
  let v = 0
  const version = port(0, {
    name: `${name}.version`,
    ...(options.onDemand ? { onDemand: options.onDemand } : {}),
    ...(options.onIdle ? { onIdle: options.onIdle } : {}),
  })

  const commit = (changes: Change<R>[]): void => {
    if (changes.length === 0) return
    log.push(++v, changes)
    version.set(v)
  }

  const apply = (patch: Patch<R>): void => {
    const changes: Change<R>[] = []
    for (const row of patch.put ?? []) {
      const key = keyOf(row)
      const prev = state.get(key)
      if (prev !== undefined && wins !== undefined && !wins(row, prev)) continue
      if (prev !== undefined && equal(prev, row)) continue
      state.set(key, row)
      changes.push(prev === undefined ? { key, next: row } : { key, prev, next: row })
    }
    for (const key of patch.drop ?? []) {
      const prev = state.get(key)
      if (prev === undefined) continue
      state.delete(key)
      changes.push({ key, prev })
    }
    commit(changes)
  }

  const replace = (rows: Iterable<R>): void => {
    const next = new Map<Key, R>()
    for (const row of rows) next.set(keyOf(row), row)
    const changes: Change<R>[] = []
    for (const [key, row] of next) {
      const prev = state.get(key)
      if (prev === undefined) changes.push({ key, next: row })
      // Membership is the snapshot's word; what the row says is still contested.
      else if ((wins !== undefined && !wins(row, prev)) || equal(prev, row)) next.set(key, prev)
      else changes.push({ key, prev, next: row })
    }
    for (const [key, prev] of state) if (!next.has(key)) changes.push({ key, prev })
    state.clear()
    for (const [key, row] of next) state.set(key, row)
    commit(changes)
  }

  const feed: Feed<R> = {
    name,
    version,
    keyOf,
    get: key => state.get(key),
    each(fn) {
      for (const row of state.values()) fn(row)
    },
    count: () => state.size,
    asMap: () => state,
    changesSince: seen => log.since(seen, v),
  }

  const self: SourceTable<R> = {
    ...tableOver(feed, () => {}),
    apply,
    // One iterable or a handful of rows: `put(rows)` and `put(a, b)` both
    // work, and neither asks the caller to spread a collection into call
    // arguments.
    put: (...rows) => apply({ put: loose(rows) as readonly R[] }),
    drop: (...keys) => apply({ drop: loose(keys) as readonly Key[] }),
    replace,
    has: key => state.has(key),
    peek: key => state.get(key),
  }
  // The spread made a new object; the feed registry must know this one too.
  remember(self, feed)
  return self
}
