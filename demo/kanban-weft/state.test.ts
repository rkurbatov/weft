// The same four trials the classic side passes, against the same server.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { kanbanServer } from '../kanban-common/server.ts'
import { kanban } from './state.ts'

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

test('load fills the board', async () => {
  const app = kanban(kanbanServer({ latency: 3 }), 60_000)
  await app.load(true)
  assert.equal(app.loading.peek(), false)
  assert.deepEqual(
    app.layout.peek().map(c => c.id),
    ['backlog', 'progress', 'review', 'done'],
  )
  assert.equal(app.layout.peek()[0]?.cardIds.length, 9)
  assert.equal(app.cards.size.peek(), 20)
  app.dispose()
})

test('a refused move shows up instantly and rolls back to where it stood', async () => {
  const app = kanban(kanbanServer({ latency: 10, grumpiness: 1 }), 60_000)
  await app.load(true)
  const before = app.layout.peek()[0]?.cardIds ?? []
  const moved = before[2]
  assert.ok(moved !== undefined)

  const done = app.move(moved, 'review', 0)
  assert.equal(app.layout.peek().find(c => c.id === 'review')?.cardIds[0], moved) // no waiting
  assert.ok(app.writes.peek().has(moved))

  await done // the server refuses
  assert.deepEqual(app.layout.peek()[0]?.cardIds, before)
  assert.equal(app.writes.peek().size, 0)
  assert.ok(app.notice.peek() !== null)
  app.dispose()
})

test('an accepted move stays', async () => {
  const app = kanban(kanbanServer({ latency: 3, grumpiness: 0 }), 60_000)
  await app.load(true)
  const moved = app.layout.peek()[0]?.cardIds[0]
  assert.ok(moved !== undefined)
  await app.move(moved, 'progress', 1)
  assert.equal(app.layout.peek().find(c => c.id === 'progress')?.cardIds[1], moved)
  assert.equal(app.writes.peek().size, 0)
  app.dispose()
})

test('polling picks up the bot: the silent reload brings a newer board', async () => {
  const server = kanbanServer({ latency: 2, grumpiness: 0, botEvery: 15 })
  const stopBot = server.startBot()
  const app = kanban(server, 25)
  await app.load(true)
  const was = app.layout
    .peek()
    .flatMap(c => c.cardIds)
    .join(' ')
  await wait(150)
  stopBot()
  app.dispose()
  assert.notEqual(
    app.layout
      .peek()
      .flatMap(c => c.cardIds)
      .join(' '),
    was,
  )
})
