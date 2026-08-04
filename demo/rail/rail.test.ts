import assert from 'node:assert/strict'
import { test } from 'node:test'
import { subscribe } from '#weft'
import { railServer } from './server.ts'
import { rail } from './state.ts'
import { held, wait } from '../../test/kit/index.ts'

test('the rail feeds itself: a look starts the feed and loads pages; leaving stops both', async () => {
  const server = railServer({ seed: 3, size: 90, pageDelay: 5, tickEvery: 10 })
  const app = held(rail(server))
  assert.equal(server.watching(), 0)

  const stop = subscribe(app.shelves.all.window(0, 12), () => {})
  assert.equal(server.watching(), 1) // the live feed followed the first look

  await wait(80) // the first page lands; the ticker runs meanwhile
  assert.ok(app.loaded.peek() >= 40)

  const rows = app.shelves.all.window(0, 12).peek()
  assert.equal(rows.length, 12)
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]
    const b = rows[i]
    assert.ok(a !== undefined && b !== undefined && a.start <= b.start)
  }

  // The shelves partition the catalogue, live.
  const { counts } = app
  assert.equal(counts.live.peek() + counts.upcoming.peek() + counts.final.peek(), counts.all.peek())

  stop()
  assert.equal(server.watching(), 0) // nobody looks — the feed rests
})

test('a page that arrives late cannot roll a live game back', async () => {
  // Pages travel six times longer than a tick: every page lands already stale.
  const server = railServer({ seed: 5, size: 60, pageDelay: 30, tickEvery: 5 })
  const app = held(rail(server))

  const seen = new Map<number, number>()
  const rollbacks: number[] = []
  const stop = subscribe(app.games.rows, rows => {
    for (const g of rows) {
      const before = seen.get(g.id)
      if (before !== undefined && g.rev < before) rollbacks.push(g.id)
      seen.set(g.id, Math.max(before ?? 0, g.rev))
    }
  })

  await wait(150) // pages and ticks interleave freely
  assert.ok(seen.size >= 40) // plenty of rows went through
  assert.deepEqual(rollbacks, [])
  stop()
})

test('typing churn asks the search once: the calm holds the abandoned questions', async () => {
  const server = railServer({ seed: 7, size: 60, pageDelay: 4, tickEvery: 1000 })
  const app = held(rail(server))

  // Three keystrokes, each look shorter than the calm (250ms in the passport).
  let stop = subscribe(app.find('no').flight, () => {})
  await wait(60)
  stop()
  stop = subscribe(app.find('nor').flight, () => {})
  await wait(60)
  stop()
  stop = subscribe(app.find('north').flight, () => {})
  await wait(400)

  assert.equal(server.searches(), 1) // only the survivor asked
  const found = app.find('north').peek()
  assert.ok(found.length > 0)
  assert.ok(found.every(g => `${g.home} ${g.away}`.toLowerCase().includes('north')))
  stop()
})

test('details come from two services and meet in one outcome', async () => {
  const server = railServer({ seed: 7, size: 60, pageDelay: 4, tickEvery: 1000 })
  const app = held(rail(server))
  const someId = 3

  const info = app.gameInfo(someId)
  const odds = app.gameOdds(someId)
  const stopInfo = subscribe(info.flight, () => {})
  const stopOdds = subscribe(odds.flight, () => {})
  await wait(40)

  // Under the law of the adjective, meeting two truths is a plain read.
  assert.ok(info.peek() !== null && info.peek()!.venue.length > 0)
  assert.ok(odds.peek() !== null && odds.peek()!.h > 1)
  assert.equal(info.flight.peek(), false)
  stopInfo()
  stopOdds()
})
