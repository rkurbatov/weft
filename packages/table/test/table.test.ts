import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { port, subscribe, watch } from '#graph'
import { table } from '#table'
import type { SourceTable } from '#table'
import { hasIds, held, until } from '#testkit'

describe('tables', () => {
  interface Row {
    id: number
    group: string
    score: number
  }

  const row = (id: number, group: string, score: number): Row => ({ id, group, score })

  /** A table, disposed of when the test ends, optionally filled on the way in. */
  function filled(...seed: Row[]): SourceTable<Row> {
    const t = held(table<Row>({ key: r => r.id }))
    if (seed.length > 0) t.put(...seed)
    return t
  }

  /** A table of `count` rows, scored by their own index. */
  function ranked(count: number, group = 'a'): SourceTable<Row> {
    const t = filled()
    for (let i = 0; i < count; i++) t.put(row(i, group, i))
    return t
  }

  function seeded(seed: number): () => number {
    let s = seed >>> 0
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 2 ** 32
    }
  }

  test('a put equal to what is there is not a change: nothing wakes, the row stays itself', () => {
    const t = filled(row(1, 'a', 10), row(2, 'b', 20))
    const kept = t.peek(1)

    let woke = 0
    until(subscribe(t.row(1), () => woke++))
    until(subscribe(t.size, () => woke++))

    t.put(row(1, 'a', 10)) // a fresh object, same content
    assert.equal(woke, 0)
    assert.equal(t.peek(1), kept)

    t.put(row(1, 'a', 11))
    assert.equal(woke, 1)
  })

  test('only the touched row wakes', () => {
    const t = filled(row(1, 'a', 10), row(2, 'b', 20))
    let one = 0
    let two = 0
    until(subscribe(t.row(1), () => one++))
    until(subscribe(t.row(2), () => two++))

    t.put(row(1, 'a', 99))
    assert.equal(one, 1)
    assert.equal(two, 0)
  })

  test('where follows by changes: one edit costs one test, not a rescan', () => {
    const t = ranked(500)

    let tested = 0
    const high = t.where(r => {
      tested++
      return r.score >= 250
    })
    until(subscribe(high.size, () => {}))
    assert.equal(tested, 500) // the first build reads everything once

    tested = 0
    t.put(row(3, 'a', 400))
    assert.equal(tested, 1)
    assert.equal(high.size.peek(), 251)
  })

  test('an edit the filter absorbs stops there: nothing below wakes', () => {
    const t = ranked(20)
    const high = t.where(r => r.score >= 100)

    let woke = 0
    until(subscribe(high.all, () => woke++))
    t.put(row(5, 'a', 6)) // was out, stays out
    t.drop(7) // was out
    assert.equal(woke, 0)

    t.put(row(5, 'a', 150)) // enters
    assert.equal(woke, 1)
  })

  test('counters move by the edit, not by the count', () => {
    const t = filled()
    for (let i = 0; i < 300; i++) t.put(row(i, i % 2 === 0 ? 'even' : 'odd', i))

    let added = 0
    const total = t.fold({
      zero: 0,
      add: (acc, r) => {
        added++
        return acc + r.score
      },
      sub: (acc, r) => acc - r.score,
    })
    until(subscribe(total, () => {}))
    assert.equal(added, 300)

    added = 0
    t.put(row(10, 'even', 1000))
    assert.equal(added, 1)
    assert.equal(total.peek(), (299 * 300) / 2 - 10 + 1000)
  })

  test('an ordered window wakes only when the window itself moves', () => {
    const t = ranked(100)
    const byScore = t.orderBy((a, b) => b.score - a.score)

    const top = byScore.slice(0, 5)
    let woke = 0
    until(subscribe(top, () => woke++))
    hasIds(top, [99, 98, 97, 96, 95])

    t.put(row(20, 'a', 50)) // moves deep below the window
    assert.equal(woke, 0)

    t.put(row(20, 'a', 1000)) // enters the window at the top
    assert.equal(woke, 1)
    hasIds(top, [20, 99, 98, 97, 96])
  })

  test('replace keeps untouched rows as the very same objects: a refetch is quiet', () => {
    const t = filled(row(1, 'a', 10), row(2, 'b', 20), row(3, 'c', 30))
    const kept = t.peek(2)

    let woke = 0
    for (const id of [1, 2, 3]) until(subscribe(t.row(id), () => woke++))

    // The server answered again: same content in fresh objects, one row really changed, one gone.
    t.replace([row(1, 'a', 10), row(2, 'b', 21)])
    assert.equal(t.peek(1), t.peek(1))
    assert.equal(woke, 2) // row 2 changed, row 3 left; row 1 slept
    assert.notEqual(t.peek(2), kept)
    assert.equal(t.size.peek(), 2)
  })

  test('a follower past the remembered changes rebuilds once and its own followers stay incremental', () => {
    const t = table<Row>({ key: r => r.id, keep: 4 })
    for (let i = 0; i < 10; i++) t.put(row(i, 'a', i))

    const high = t.where(r => r.score >= 5)
    const count = high.count(r => r.score >= 8)
    assert.equal(count.peek(), 2) // builds both, then both go cold

    // Far more batches than the log remembers.
    for (let i = 0; i < 40; i++) t.put(row(100 + i, 'a', i % 10))
    t.drop(9)

    assert.equal(high.size.peek(), 4 + 20)
    assert.equal(count.peek(), 1 + 8) // one survivor, plus fresh scores 8 and 9, four of each
  })

  test('oracle: every derived answer equals a oracle from scratch, at every step', () => {
    const chance = seeded(7)
    const t = table<Row>({ key: r => r.id, keep: 8 })
    const model = new Map<number, Row>()

    const high = t.where(r => r.score >= 50)
    const evens = high.where(r => r.group === 'even')
    const ordered = t.orderBy((a, b) => a.score - b.score || a.id - b.id)
    const total = t.sumBy(r => r.score)
    const highCount = t.count(r => r.score >= 50)

    const ids = (rows: readonly Row[]): number[] => rows.map(r => r.id).toSorted((a, b) => a - b)
    const check = (): void => {
      const rows = [...model.values()]
      assert.deepEqual(ids(high.all.peek()), ids(rows.filter(r => r.score >= 50)))
      assert.deepEqual(
        ids(evens.all.peek()),
        ids(rows.filter(r => r.score >= 50 && r.group === 'even')),
      )
      const sorted = rows.toSorted((a, b) => a.score - b.score || a.id - b.id)
      assert.deepEqual(
        ordered
          .slice(0, rows.length)
          .peek()
          .map(r => r.id),
        sorted.map(r => r.id),
      )
      assert.equal(
        total.peek(),
        rows.reduce((acc, r) => acc + r.score, 0),
      )
      assert.equal(highCount.peek(), rows.filter(r => r.score >= 50).length)
    }

    for (let step = 0; step < 300; step++) {
      const roll = chance()
      if (roll < 0.55) {
        const id = Math.floor(chance() * 60)
        const fresh = row(id, chance() < 0.5 ? 'even' : 'odd', Math.floor(chance() * 100))
        t.put(fresh)
        model.set(id, fresh)
      } else if (roll < 0.8) {
        const id = Math.floor(chance() * 60)
        t.drop(id)
        model.delete(id)
      } else if (roll < 0.95) {
        const puts: Row[] = []
        for (let i = 0; i < 5; i++) {
          const id = Math.floor(chance() * 60)
          puts.push(row(id, chance() < 0.5 ? 'even' : 'odd', Math.floor(chance() * 100)))
        }
        const gone = Math.floor(chance() * 60)
        t.apply({ put: puts, drop: [gone] })
        // apply works puts first, drops after; the model mirrors that order
        for (const r of puts) model.set(r.id, r)
        model.delete(gone)
      } else {
        const kept = [...model.values()].filter(() => chance() < 0.7)
        t.replace(kept)
        model.clear()
        for (const r of kept) model.set(r.id, r)
      }
      check()
    }
  })

  test('a page that travelled slowly loses to the event that overtook it', () => {
    interface Versioned {
      id: number
      score: number
      rev: number
    }
    const t = table<Versioned>({ key: r => r.id, wins: (next, prev) => next.rev >= prev.rev })
    t.put({ id: 1, score: 0, rev: 1 }) // the page was photographed here
    t.put({ id: 1, score: 3, rev: 5 }) // a live event lands first

    let woke = 0
    until(subscribe(t.row(1), () => woke++))
    t.put({ id: 1, score: 0, rev: 1 }) // the page finally arrives, stale
    assert.equal(woke, 0)
    assert.equal(t.peek(1)?.score, 3)

    t.replace([{ id: 1, score: 0, rev: 1 }]) // even as a whole snapshot
    assert.equal(t.peek(1)?.score, 3)
  })

  test('demand reaches the table through anything derived from it', () => {
    const t = held(
      table<Row>({
        key: r => r.id,
        onDemand: () => log.push('on'),
        onIdle: () => log.push('off'),
      }),
    )
    const log: string[] = []
    t.put(row(1, 'a', 10))
    const top = t.where(r => r.score > 5).orderBy((a, b) => b.score - a.score)

    const stop = until(subscribe(top.slice(0, 3), () => {}))
    assert.deepEqual(log, ['on'])
    stop() // the last watcher leaves: the table hears it
    assert.deepEqual(log, ['on', 'off'])
  })

  test('rank follows the living order: a birth above shifts it, absence is -1', () => {
    const t = filled(row(1, 'a', 10), row(2, 'a', 20), row(3, 'a', 30))
    const byScore = t.orderBy((a, b) => a.score - b.score)
    assert.equal(byScore.rank(3), 2)

    t.put(row(4, 'a', 5)) // lands above everything
    assert.equal(byScore.rank(3), 3)

    t.drop(3)
    assert.equal(byScore.rank(3), -1)
  })

  test('whereLive: the predicate is a formula, so typing re-filters the view', () => {
    const people = table<{ id: number; name: string }>({ key: p => p.id, name: 'people' })
    people.put({ id: 1, name: 'anna' }, { id: 2, name: 'boris' }, { id: 3, name: 'anatoly' })
    const query = port('', { name: 'query' })
    const found = held(
      people.whereLive(() => {
        const text = query.get()
        return p => p.name.startsWith(text)
      }, 'found'),
    )

    const seen: number[] = []
    until(watch(() => seen.push(found.size.get())))
    assert.equal(seen.at(-1), 3)

    query.set('an')
    assert.equal(found.size.peek(), 2)
    assert.deepEqual(
      found.all.peek().map(p => p.id),
      [1, 3],
    )

    query.set('b')
    assert.equal(found.size.peek(), 1)

    // A row arriving while the filter stands is judged by the live predicate.
    people.put({ id: 4, name: 'bella' })
    assert.equal(found.size.peek(), 2)

    query.set('')
    assert.equal(found.size.peek(), 4)
  })

  test('whereLive: followers hear only the difference when the filter moves', () => {
    const rows = table<{ id: number; n: number }>({ key: r => r.id, name: 'rows' })
    for (let id = 1; id <= 20; id++) rows.put({ id, n: id })
    const floor = port(0, { name: 'floor' })
    const above = held(
      rows.whereLive(() => {
        const least = floor.get()
        return r => r.n > least
      }, 'above'),
    )

    let told = 0
    until(
      watch(() => {
        above.size.get()
        told++
      }),
    )
    assert.equal(above.size.peek(), 20)

    floor.set(18)
    assert.equal(above.size.peek(), 2)
    assert.equal(told, 2) // one wake for the change, not one per row dropped
  })
})
