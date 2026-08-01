import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subscribe } from '#core/graph.ts'
import { railServer } from './server.ts'
import { rail } from './state.ts'

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

test('the rail feeds itself: a look starts the feed and loads pages; leaving stops both', async () => {
  const server = railServer({ seed: 3, size: 90, pageDelay: 5, tickEvery: 10 })
  const app = rail(server)
  assert.equal(server.watching(), 0)

  const stop = subscribe(app.shelves.all.slice(0, 12), () => {})
  assert.equal(server.watching(), 1) // the live feed followed the first look

  await wait(80) // the first page lands; the ticker runs meanwhile
  assert.ok(app.loaded.peek() >= 40)

  const rows = app.shelves.all.slice(0, 12).peek()
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
  app.dispose()
})

test('a page that arrives late cannot roll a live game back', async () => {
  // Pages travel six times longer than a tick: every page lands already stale.
  const server = railServer({ seed: 5, size: 60, pageDelay: 30, tickEvery: 5 })
  const app = rail(server)

  const seen = new Map<number, number>()
  const rollbacks: number[] = []
  const stop = subscribe(app.games.all, rows => {
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
  app.dispose()
})
