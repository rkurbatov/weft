// The live views over a table: an order, a window into it, and a filter that
// can follow a formula.
//
// Each is a table in its own right — that is what lets them be stacked — and
// each keeps only what its own answer needs: an order keeps a sorted line, a
// filter keeps who passes.

import { derived, family } from '#graph'
import type { Key } from '#feed'
import { changeLog, follow, KEEP } from '#feed'
import { sameItems } from './same.ts'
import type { Change, Feed, Ordered, Table } from './contract.ts'
import { tableOver } from './over.ts'

function keyCompare(a: Key, b: Key): number {
  if (a === b) return 0
  if (typeof a !== typeof b) return typeof a === 'number' ? -1 : 1
  return a < b ? -1 : 1
}

export function orderedOver<R>(
  feed: Feed<R>,
  compare: (a: R, b: R) => number,
  name: string,
): Ordered<R> {
  interface Note {
    key: Key
    row: R
  }
  // Equal rows are tied by key, so every entry has one place and can be found again.
  const order = (a: Note, b: Note): number => compare(a.row, b.row) || keyCompare(a.key, b.key)
  let entries: Note[] = []
  let v = 0

  const lowerBound = (e: Note): number => {
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

  /**
   * Past this many changes, splicing one by one loses to merging.
   *
   * A splice shifts the tail, so a batch of K over N entries costs K×N moves —
   * an initial sync of five thousand rows onto five thousand held ones is
   * twenty-five million shifts, and the thread freezes. One filtering pass
   * and one merge of two sorted runs costs N + K·logK instead. The same
   * threshold, for the same reason, as the relational scan's.
   */
  const BATCH = 8

  const applyMany = (changes: readonly Change<R>[]): void => {
    // One resolution per key, the last one in the batch: a batch may carry
    // the same key twice — two puts of one row arrive as two changes — and
    // splicing them in turn replaces, while a naive merge would keep both.
    const finals = new Map<Key, R | undefined>()
    for (const c of changes) finals.set(c.key, c.next)
    const kept = entries.filter(e => !finals.has(e.key))
    const fresh: Note[] = []
    for (const [key, row] of finals) if (row !== undefined) fresh.push({ key, row })
    fresh.sort(order)
    const merged: Note[] = Array.from({ length: kept.length + fresh.length })
    let a = 0
    let b = 0
    let at = 0
    while (a < kept.length && b < fresh.length) {
      merged[at++] = (
        order(kept[a] as Note, fresh[b] as Note) <= 0 ? kept[a++] : fresh[b++]
      ) as Note
    }
    while (a < kept.length) merged[at++] = kept[a++] as Note
    while (b < fresh.length) merged[at++] = fresh[b++] as Note
    entries = merged
  }

  const ensure = follow(feed, {
    first: rebuild,
    apply(changes) {
      if (changes.length >= BATCH) {
        applyMany(changes)
      } else {
        for (const c of changes) {
          if (c.prev !== undefined) remove(c.key, c.prev)
          if (c.next !== undefined) insert(c.key, c.next)
        }
      }
      v++
    },
    resync() {
      rebuild()
      v++
    },
  })

  const version = derived(
    () => {
      ensure()
      return v
    },
    { name: `${name}.version` },
  )

  const read = (from: number, to: number): readonly R[] => {
    version.get()
    return entries.slice(Math.max(0, from), Math.max(0, to)).map(e => e.row)
  }

  const windows = family<string, readonly R[]>(
    span => {
      const [from = 0, to = 0] = span.split(':').map(Number)
      return read(from, to)
    },
    { name: `${name}.slice`, equal: sameItems },
  )

  const all = derived(() => read(0, Number.POSITIVE_INFINITY), {
    name: `${name}.all`,
    equal: sameItems,
  })

  const size = derived(
    () => {
      version.get()
      return entries.length
    },
    { name: `${name}.size` },
  )

  return {
    size,
    all,
    read,
    get watched() {
      // Only what somebody outside could be holding: the count, the whole
      // order, and the windows asked for by name. `version` is not in the
      // list — every cell here reads it, so it is observed from the moment
      // anything is built, which says nothing about whether anybody is
      // looking.
      return size.observed || all.observed || windows.watched
    },
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
    dispose: () => {
      all.dispose()
      version.dispose()
    },
  }
}

/** Before the first predicate arrives nothing is filtered out. */
const passes = (): boolean => true

export function whereOver<R>(
  parent: Feed<R>,
  pick: () => (row: R) => boolean,
  name: string,
): Table<R> {
  const state = new Map<Key, R>()
  const log = changeLog<R>(KEEP)
  let v = 0
  // The living predicate: whatever `pick` reads is a dependency, so a filter
  // typed into a field is an ordinary cell change, not a rebuild by hand.
  const chosen = derived(pick, { name: `${name}.test` })
  let test: (row: R) => boolean = passes
  let judged = false

  const rebuild = (): Map<Key, R> => {
    const fresh = new Map<Key, R>()
    parent.each(row => {
      if (test(row)) fresh.set(parent.keyOf(row), row)
    })
    return fresh
  }

  /**
   * Take the rebuilt picture, but tell followers only the difference.
   *
   * This is what keeps a live predicate from being a wrecking ball. Typing a
   * letter into a search box changes the filter globally — the honest new
   * answer is a rebuild — but a rebuild HANDED ON as a new collection would
   * reset every structure downstream: the sort re-sorts everything, the
   * offsets line rebuilds, the wire sends a table instead of a delta, and
   * memoised rows all redraw. Diffed here against what followers already
   * hold, the global change travels as the handful of rows that actually
   * entered or left, and everything downstream keeps its incremental price.
   */
  const settleTo = (fresh: Map<Key, R>): void => {
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
      settleTo(rebuild())
    },
  })

  const version = derived(
    () => {
      const next = chosen.get()
      const moved = judged && next !== test
      test = next
      judged = true
      ensure()
      // A new predicate means every row is judged again — but followers still
      // hear only what actually moved. The first build is not a move: the
      // predicate arrives before anything has been judged by it.
      if (moved) settleTo(rebuild())
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
    asMap: () => state,
    changesSince: seen => log.since(seen, v),
  }

  return tableOver(feed, () => {
    version.dispose()
    chosen.dispose()
  })
}
