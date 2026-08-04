import assert from 'node:assert/strict'
import { test } from 'node:test'
import { subscribe } from '#weft'
import { byEach, feed, fold, keyedBy, shape } from '#loom'

interface Game {
  id: number
  status: 'live' | 'upcoming' | 'final'
  start: number
  goals: number
}

const make = () => {
  const games = keyedBy(feed<Game>({ name: 'games', key: g => g.id }), 'id')
  games.take(
    { id: 1, status: 'live', start: 20, goals: 3 },
    { id: 2, status: 'live', start: 10, goals: 1 },
    { id: 3, status: 'final', start: 5, goals: 4 },
  )
  return games
}

test('a declared shape answers as a nested structure, and follows edits', () => {
  const games = make()
  const rail = shape(
    {
      shelves: byEach(games, 'status', g => ({
        name: g.key('status'),
        n: g.count(),
        goals: g.sum('goals'),
        rows: g.rows('start'),
      })),
      totals: fold(games, g => ({ n: g.count(), goals: g.sum('goals') })),
    },
    { name: 'rail' },
  )
  const stop = subscribe(rail.shelves, () => {})
  const stopTotals = subscribe(rail.totals, () => {})

  const shelves = [...rail.shelves.peek()].toSorted((a, b) => (a.name < b.name ? -1 : 1))
  assert.deepEqual(
    shelves.map(s => [s.name, s.n, s.goals]),
    [
      ['final', 1, 4],
      ['live', 2, 4],
    ],
  )
  assert.equal(shelves[1]?.rows.length, 2)
  assert.deepEqual(
    shelves[1]?.rows.map(r => r.id),
    [2, 1],
    'a shelf keeps its own order, not the key order',
  )
  assert.deepEqual(rail.totals.peek(), { n: 3, goals: 8 })

  games.take({ id: 2, status: 'final', start: 20, goals: 2 })
  const after = [...rail.shelves.peek()].toSorted((a, b) => (a.name < b.name ? -1 : 1))
  assert.deepEqual(
    after.map(s => [s.name, s.n, s.goals]),
    [
      ['final', 2, 6],
      ['live', 1, 3],
    ],
  )
  assert.deepEqual(rail.totals.peek(), { n: 3, goals: 9 })

  stopTotals()
  stop()
  games.dispose()
})

test('the whole-collection fold lives even over nothing', () => {
  const games = keyedBy(feed<Game>({ name: 'games', key: g => g.id }), 'id')
  const totals = shape({ all: fold(games, g => ({ n: g.count() })) })
  const stop = subscribe(totals.all, () => {})
  assert.deepEqual(totals.all.peek(), { n: 0 })
  games.take({ id: 9, status: 'live', start: 1, goals: 0 })
  assert.deepEqual(totals.all.peek(), { n: 1 })
  stop()
  games.dispose()
})
