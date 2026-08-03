// Live tables: keyed collections that move by changes, not snapshots.
//
// A table is to a collection what a cell is to a value. Everything derived —
// filters, orders, folds — consumes the changes and keeps its own answer, so
// the cost of an edit is the size of the edit, not the size of the collection.
// A follower that fell too far behind rebuilds once and goes on incrementally.

import { cell, input } from './graph.ts'
import type { Cell, Equal, Watchable } from './graph.ts'
import { family } from './family.ts'

export type Key = string | number

/** One key's move: insert (no prev), update (both sides), removal (no next). */
export interface Change<R> {
  key: Key
  prev?: R
  next?: R
}

export interface Patch<R> {
  put?: readonly R[]
  drop?: readonly Key[]
}

export interface FoldSpec<R, A> {
  zero: A
  add(acc: A, row: R): A
  /** Undo one row. With it an edit costs O(1); without it the fold recounts. */
  sub?(acc: A, row: R): A
  equal?: Equal<A>
}

export interface Ordered<R> {
  readonly size: Watchable<number>
  /** Rows [from, to) in order. The same window is the same cell. */
  slice(from: number, to: number): Watchable<readonly R[]>
  /** Where this key stands right now, -1 when absent. Plain and untracked:
   *  made for scroll anchoring, not for formulas. */
  rank(key: Key): number
  dispose(): void
}

export interface Table<R> {
  readonly name: string
  readonly size: Watchable<number>
  /** Every row, insertion-ordered. The honest slow path; prefer views and folds. */
  readonly all: Watchable<readonly R[]>
  /** The cell for one row; wakes only when that row moves. */
  row(key: Key): Watchable<R | undefined>
  where(test: (row: R) => boolean, name?: string): Table<R>
  orderBy(compare: (a: R, b: R) => number, name?: string): Ordered<R>
  fold<A>(spec: FoldSpec<R, A>, name?: string): Watchable<A>
  count(test?: (row: R) => boolean): Watchable<number>
  sumBy(measure: (row: R) => number): Watchable<number>
  dispose(): void
}

export interface SourceTable<R> extends Table<R> {
  /** One batch, one version step; a put equal to what is there is not a change. */
  apply(patch: Patch<R>): void
  put(...rows: R[]): void
  drop(...keys: Key[]): void
  /** The whole picture anew — pages and snapshots land here. Kept rows keep their identity. */
  replace(rows: Iterable<R>): void
  has(key: Key): boolean
  peek(key: Key): R | undefined
}

export interface TableOptions<R> {
  key(row: R): Key
  name?: string
  /** What counts as the same row. Structural by default. */
  equal?: Equal<R>
  /**
   * Who stands when two writers bring the same key: an incoming row that does
   * not win is dropped without a trace. This is how a page that travelled
   * slowly loses to the live event that overtook it. Absent, incoming wins.
   */
  wins?(incoming: R, standing: R): boolean
  /** Change batches remembered for followers; an older follower rebuilds instead. */
  keep?: number
  /** First live watcher arrived — anywhere downstream. Time to feed the table. */
  onDemand?: () => void
  /** Last live watcher left. Whatever feeds the table may rest. */
  onIdle?: () => void
}

const KEEP = 64

/** Structural sameness over JSON-shaped values. */
export function alike(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false
    for (const [key, value] of a) {
      if (!b.has(key) || !alike(value, b.get(key))) return false
    }
    return true
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false
    for (const item of a) if (!b.has(item)) return false
    return true
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => alike(item, b[i]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const names = Object.keys(left)
  if (names.length !== Object.keys(right).length) return false
  return names.every(n => n in right && alike(left[n], right[n]))
}

const sameItems = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((item, i) => Object.is(item, b[i]))

// What a derived thing needs from what it follows. State reads are only valid
// after reading version: the read is what brings the follower up to date.
interface Feed<R> {
  readonly name: string
  readonly version: Watchable<number>
  keyOf(row: R): Key
  get(key: Key): R | undefined
  each(fn: (row: R) => void): void
  count(): number
  /** Changes after the given version, or null when they are no longer remembered. */
  changesSince(v: number): Change<R>[] | null
}

interface ChangeLog<R> {
  push(v: number, changes: Change<R>[]): void
  since(v: number, current: number): Change<R>[] | null
}

function changeLog<R>(keep: number): ChangeLog<R> {
  const batches: Array<{ v: number; changes: Change<R>[] }> = []
  return {
    push(v, changes) {
      batches.push({ v, changes })
      while (batches.length > keep) batches.shift()
    },
    since(v, current) {
      if (v === current) return []
      const oldest = batches[0]
      if (oldest === undefined || v < oldest.v - 1) return null
      const out: Change<R>[] = []
      for (const b of batches) if (b.v > v) out.push(...b.changes)
      return out
    },
  }
}

interface Follower<R> {
  first(): void
  apply(changes: readonly Change<R>[]): void
  resync(): void
}

/** The one pattern every derived thing shares: build once, then eat changes. */
function follow<R>(feed: Feed<R>, on: Follower<R>): () => void {
  let started = false
  let seen = 0
  return () => {
    const now = feed.version.get()
    if (!started) {
      started = true
      on.first()
      seen = now
      return
    }
    if (now === seen) return
    const changes = feed.changesSince(seen)
    if (changes === null) on.resync()
    else if (changes.length > 0) on.apply(changes)
    seen = now
  }
}

function foldOver<R, A>(feed: Feed<R>, spec: FoldSpec<R, A>, name: string): Cell<A> {
  let acc = spec.zero
  const recount = (): void => {
    acc = spec.zero
    feed.each(row => {
      acc = spec.add(acc, row)
    })
  }
  const ensure = follow(feed, {
    first: recount,
    apply(changes) {
      const sub = spec.sub
      if (sub === undefined) {
        recount()
        return
      }
      for (const c of changes) {
        if (c.prev !== undefined) acc = sub(acc, c.prev)
        if (c.next !== undefined) acc = spec.add(acc, c.next)
      }
    },
    resync: recount,
  })
  return cell(
    () => {
      ensure()
      return acc
    },
    { name, equal: spec.equal ?? Object.is },
  )
}

function keyCompare(a: Key, b: Key): number {
  if (a === b) return 0
  if (typeof a !== typeof b) return typeof a === 'number' ? -1 : 1
  return a < b ? -1 : 1
}

function orderedOver<R>(feed: Feed<R>, compare: (a: R, b: R) => number, name: string): Ordered<R> {
  interface Entry {
    key: Key
    row: R
  }
  // Equal rows are tied by key, so every entry has one place and can be found again.
  const order = (a: Entry, b: Entry): number => compare(a.row, b.row) || keyCompare(a.key, b.key)
  let entries: Entry[] = []
  let v = 0

  const lowerBound = (e: Entry): number => {
    let lo = 0
    let hi = entries.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const at = entries[mid]
      if (at !== undefined && order(at, e) < 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  const insert = (key: Key, row: R): void => {
    const e = { key, row }
    entries.splice(lowerBound(e), 0, e)
  }

  const remove = (key: Key, row: R): void => {
    const e = { key, row }
    let i = lowerBound(e)
    while (i < entries.length) {
      const at = entries[i]
      if (at === undefined || order(at, e) !== 0) return
      if (at.key === key) {
        entries.splice(i, 1)
        return
      }
      i++
    }
  }

  const rebuild = (): void => {
    entries = []
    feed.each(row => entries.push({ key: feed.keyOf(row), row }))
    entries.sort(order)
  }

  const ensure = follow(feed, {
    first: rebuild,
    apply(changes) {
      for (const c of changes) {
        if (c.prev !== undefined) remove(c.key, c.prev)
        if (c.next !== undefined) insert(c.key, c.next)
      }
      v++
    },
    resync() {
      rebuild()
      v++
    },
  })

  const version = cell(
    () => {
      ensure()
      return v
    },
    { name: `${name}.version` },
  )

  const windows = family<string, readonly R[]>(
    span => {
      version.get()
      const [from = 0, to = 0] = span.split(':').map(Number)
      return entries.slice(Math.max(0, from), Math.max(0, to)).map(e => e.row)
    },
    { name: `${name}.slice`, equal: sameItems },
  )

  const size = cell(
    () => {
      version.get()
      return entries.length
    },
    { name: `${name}.size` },
  )

  return {
    size,
    slice: (from, to) => windows(`${from}:${to}`),
    rank(key) {
      version.peek() // brings the order up to date without becoming a dependency
      const row = feed.get(key)
      if (row === undefined) return -1
      const wanted = { key, row }
      let i = lowerBound(wanted)
      while (i < entries.length) {
        const at = entries[i]
        if (at === undefined || order(at, wanted) !== 0) return -1
        if (at.key === key) return i
        i++
      }
      return -1
    },
    dispose: () => version.dispose(),
  }
}

function whereOver<R>(parent: Feed<R>, test: (row: R) => boolean, name: string): Table<R> {
  const state = new Map<Key, R>()
  const log = changeLog<R>(KEEP)
  let v = 0

  const rebuild = (): Map<Key, R> => {
    const fresh = new Map<Key, R>()
    parent.each(row => {
      if (test(row)) fresh.set(parent.keyOf(row), row)
    })
    return fresh
  }

  const ensure = follow(parent, {
    first() {
      for (const [key, row] of rebuild()) state.set(key, row)
    },
    apply(changes) {
      const mine: Change<R>[] = []
      for (const c of changes) {
        const had = state.get(c.key)
        const next = c.next !== undefined && test(c.next) ? c.next : undefined
        if (next !== undefined) {
          state.set(c.key, next)
          mine.push(had === undefined ? { key: c.key, next } : { key: c.key, prev: had, next })
        } else if (had !== undefined) {
          state.delete(c.key)
          mine.push({ key: c.key, prev: had })
        }
      }
      if (mine.length > 0) log.push(++v, mine)
    },
    resync() {
      // A diff against the rebuilt picture keeps our own followers incremental.
      const fresh = rebuild()
      const mine: Change<R>[] = []
      for (const [key, row] of fresh) {
        const had = state.get(key)
        if (had === undefined) mine.push({ key, next: row })
        else if (!Object.is(had, row)) mine.push({ key, prev: had, next: row })
      }
      for (const [key, had] of state) if (!fresh.has(key)) mine.push({ key, prev: had })
      state.clear()
      for (const [key, row] of fresh) state.set(key, row)
      if (mine.length > 0) log.push(++v, mine)
    },
  })

  const version = cell(
    () => {
      ensure()
      return v
    },
    { name: `${name}.version` },
  )

  const feed: Feed<R> = {
    name,
    version,
    keyOf: parent.keyOf,
    get: key => state.get(key),
    each(fn) {
      for (const row of state.values()) fn(row)
    },
    count: () => state.size,
    changesSince: seen => log.since(seen, v),
  }

  return tableOver(feed, () => version.dispose())
}

/** The reading surface every table shares, source and derived alike. */
function tableOver<R>(feed: Feed<R>, dispose: () => void): Table<R> {
  const rows = family<Key, R | undefined>(
    key => {
      feed.version.get()
      return feed.get(key)
    },
    { name: `${feed.name}.row` },
  )

  const size = cell(
    () => {
      feed.version.get()
      return feed.count()
    },
    { name: `${feed.name}.size` },
  )

  const all = cell(
    () => {
      feed.version.get()
      const out: R[] = []
      feed.each(row => out.push(row))
      return out as readonly R[]
    },
    { name: `${feed.name}.all`, equal: sameItems },
  )

  const self: Table<R> = {
    name: feed.name,
    size,
    all,
    row: key => rows(key),
    where: (test, name) => whereOver(feed, test, name ?? `${feed.name}.where`),
    orderBy: (compare, name) => orderedOver(feed, compare, name ?? `${feed.name}.order`),
    fold: (spec, name) => foldOver(feed, spec, name ?? `${feed.name}.fold`),
    count: test =>
      test === undefined
        ? size
        : foldOver(
            feed,
            {
              zero: 0,
              add: (acc, row) => acc + (test(row) ? 1 : 0),
              sub: (acc, row) => acc - (test(row) ? 1 : 0),
            },
            `${feed.name}.count`,
          ),
    sumBy: measure =>
      foldOver(
        feed,
        {
          zero: 0,
          add: (acc, row) => acc + measure(row),
          sub: (acc, row) => acc - measure(row),
        },
        `${feed.name}.sum`,
      ),
    dispose,
  }
  return self
}

export function table<R>(options: TableOptions<R>): SourceTable<R> {
  const name = options.name ?? 'table'
  const keyOf = options.key
  const equal = options.equal ?? alike
  const wins = options.wins
  const state = new Map<Key, R>()
  const log = changeLog<R>(options.keep ?? KEEP)
  let v = 0
  const version = input(0, {
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
    changesSince: seen => log.since(seen, v),
  }

  return {
    ...tableOver(feed, () => {}),
    apply,
    put: (...rows) => apply({ put: rows }),
    drop: (...keys) => apply({ drop: keys }),
    replace,
    has: key => state.has(key),
    peek: key => state.get(key),
  }
}
