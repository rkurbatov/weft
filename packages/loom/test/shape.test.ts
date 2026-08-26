import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { subscribe } from '#weft'
import { byEach, cell, live, fold, keyedBy, list, listsBy, shape } from '#loom'
import { hasIds, until } from '#testkit'
import type { ListView } from '#loom'

describe('the shape of an answer', () => {
  interface Game {
    id: number
    status: 'live' | 'upcoming' | 'final'
    start: number
    goals: number
  }

  const make = () => {
    const games = live<Game>({ name: 'games', key: g => g.id })
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
    const games = live<Game>({ name: 'games', key: g => g.id })
    const totals = shape({ all: fold(games, g => ({ n: g.count() })) })
    const stop = subscribe(totals.all, () => {})
    assert.deepEqual(totals.all.peek(), { n: 0 })
    games.take({ id: 9, status: 'live', start: 1, goals: 0 })
    assert.deepEqual(totals.all.peek(), { n: 1 })
    stop()
    games.dispose()
  })

  test('an ordered list with no window answers in that order', () => {
    // The order was built and then nobody read it: without a window the rows
    // came straight off the source, in whatever order the feed held them.
    const games = live<Game>({ name: 'ordered', key: g => g.id })
    const board = shape({ soonest: list(games, { order: 'start' }) }, { name: 'ordered' })
    until(subscribe(board.soonest.rows, () => {}))

    games.take({ id: 1, status: 'live', start: 30, goals: 0 })
    games.take({ id: 2, status: 'live', start: 10, goals: 0 })
    games.take({ id: 3, status: 'live', start: 20, goals: 0 })
    assert.deepEqual(
      board.soonest.rows.peek().map(g => g.id),
      [2, 3, 1],
    )

    games.take({ id: 4, status: 'live', start: 5, goals: 0 })
    assert.deepEqual(
      board.soonest.rows.peek().map(g => g.id),
      [4, 2, 3, 1],
      'a row arriving late still lands where the order puts it',
    )
  })

  test('a form nests: a sub-form is built through, not handed back unbuilt', () => {
    const games = live<Game>({ name: 'nested', key: g => g.id })
    const screen = shape(
      {
        header: { total: fold(games, g => g.count()) },
        board: { byStatus: listsBy(games, 'status', { order: 'start' }) },
      },
      { name: 'nested' },
    )
    until(subscribe(screen.header.total, () => {}))
    const onNow = (screen.board.byStatus as Record<string, ListView<Game>>)[
      'live'
    ] as ListView<Game>
    until(subscribe(onNow.size, () => {}))

    games.take({ id: 1, status: 'live', start: 10, goals: 0 })
    games.take({ id: 2, status: 'final', start: 5, goals: 3 })
    assert.equal(screen.header.total.peek(), 2)
    assert.equal(onNow.size.peek(), 1)
  })

  test('a fold declaration is run once, not twice', () => {
    // A caller reasonably reads the declaration as a description of what is
    // wanted; it was quietly a function run twice, once to sniff its shape and
    // once to build.
    const games = live<Game>({ name: 'once', key: g => g.id })
    let runs = 0
    const board = shape(
      {
        n: fold(games, g => {
          runs++
          return g.count()
        }),
      },
      { name: 'once' },
    )
    until(subscribe(board.n, () => {}))
    games.take({ id: 1, status: 'live', start: 10, goals: 0 })
    assert.equal(board.n.peek(), 1)
    assert.equal(runs, 1)
  })

  test('shelves are kept to a ceiling, and the whole shelf is never dropped', () => {
    // Grouping by a field with a value per row used to keep a window per row
    // for as long as the screen lived.
    const games = live<Game>({ name: 'crowded', key: g => g.id })
    const board = shape(
      { byStart: listsBy(games, 'start', { order: 'start', whole: 'all', keep: 4 }) },
      { name: 'crowded' },
    )
    const shelves = board.byStart as unknown as Record<string, ListView<Game>>
    for (let i = 0; i < 20; i++) games.take({ id: i, status: 'live', start: i, goals: 0 })
    for (let i = 0; i < 20; i++) void shelves[String(i)]
    void shelves['all']
    assert.equal(Object.keys(shelves).length <= 5, true, `kept ${Object.keys(shelves).length}`)
    assert.equal(Object.keys(shelves).includes('all'), true, 'the whole shelf was evicted')
  })
})

describe('a single list, and keys stated by hand', () => {
  interface Row {
    id: number
    at: number
    lane: string
  }

  test('a window moves with the cell that says where it starts', () => {
    const rows = live<Row>({ name: 'rows', key: r => r.id })
    const from = cell(0)
    const board = shape(
      { page: list(rows, { order: 'at', window: { from, size: 2 } }) },
      { name: 'paged' },
    )
    until(subscribe(board.page.rows, () => {}))
    until(subscribe(board.page.size, () => {}))

    rows.take(
      { id: 1, at: 10, lane: 'a' },
      { id: 2, at: 20, lane: 'a' },
      { id: 3, at: 30, lane: 'b' },
    )

    hasIds(board.page.rows, [1, 2], 'the first window')
    assert.equal(board.page.size.peek(), 3, 'and the whole length, not the window')

    from.set(1)
    hasIds(board.page.rows, [2, 3], 'the window moved, the list did not')
    assert.equal(board.page.place(3), 2, 'and a row knows where it stands')
  })

  test('a key computed out of the air is stated by hand', () => {
    // Nothing to learn from `key`, so the fields are named — and then the
    // shelves work as if they had been learnt.
    const rows = keyedBy(
      live<Row>({ name: 'rows', key: r => `${r.lane}/${String(r.id)}`.toUpperCase() }),
      'id',
    )
    const board = shape({ byLane: listsBy(rows, 'lane', { order: 'at' }) }, { name: 'stated' })
    const shelf = (lane: string): ListView<Row> =>
      (board.byLane as Record<string, ListView<Row>>)[lane] as ListView<Row>
    until(subscribe(shelf('a').size, () => {}))
    until(subscribe(shelf('b').size, () => {}))

    rows.take({ id: 1, at: 10, lane: 'a' }, { id: 2, at: 20, lane: 'b' })
    assert.equal(shelf('a').size.peek(), 1)
    assert.equal(shelf('b').size.peek(), 1)
  })
})

describe('shelves taken from the data', () => {
  interface Ticket {
    id: number
    state: 'open' | 'done'
    weight: number
    at: number
  }

  const ticket = (id: number, state: Ticket['state'], weight: number, at: number): Ticket => ({
    id,
    state,
    weight,
    at,
  })

  test('one shelf per value of a field, built on first look and kept after', () => {
    const tickets = live<Ticket>({ name: 'tickets', key: t => t.id })
    const board = shape(
      { shelves: listsBy(tickets, 'state', { order: 'at', whole: 'all' }) },
      { name: 'board' },
    )
    // A form is alive while somebody looks at it, like everything here.
    until(subscribe(board.shelves.all.size, () => {}))
    until(subscribe(board.shelves.open.rows, () => {}))
    until(subscribe(board.shelves.done.size, () => {}))
    tickets.take(ticket(1, 'open', 3, 10), ticket(2, 'done', 5, 20), ticket(3, 'open', 1, 30))

    assert.equal(board.shelves.all.size.peek(), 3)
    assert.equal(board.shelves.open.size.peek(), 2)
    assert.equal(board.shelves.done.size.peek(), 1)
    hasIds(board.shelves.open.rows, [1, 3], 'ordered by the field named once')

    // The same shelf, asked for twice, is the same shelf.
    assert.equal(board.shelves.open, board.shelves.open)
  })

  test('a value nobody has seen yet gets its shelf when it arrives', () => {
    const tickets = live<Ticket>({ name: 'tickets', key: t => t.id })
    const board = shape({ shelves: listsBy(tickets, 'state', { order: 'at' }) }, { name: 'later' })
    until(subscribe(board.shelves.done.size, () => {}))
    tickets.take(ticket(1, 'open', 3, 10))
    assert.equal(board.shelves.done.size.peek(), 0, 'an empty shelf is a shelf, not an error')

    tickets.take(ticket(2, 'done', 1, 5))
    assert.equal(board.shelves.done.size.peek(), 1)
  })

  test('a measure of one’s own, over a shelf’s worth of rows', () => {
    const tickets = live<Ticket>({ name: 'tickets', key: t => t.id })
    const board = shape(
      {
        weight: fold(
          tickets,
          g => g.sum(t => t.weight * 2),
          t => t.state === 'open',
        ),
      },
      { name: 'weights' },
    )
    until(subscribe(board.weight, () => {}))
    tickets.take(ticket(1, 'open', 3, 10), ticket(2, 'done', 5, 20), ticket(3, 'open', 1, 30))
    assert.equal(board.weight.peek(), 8)
  })
})
