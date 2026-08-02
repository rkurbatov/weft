// The four trials the classic passes, plus the fifth it cannot.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subscribe } from '#core/graph.ts'
import { kanbanServer } from '../kanban-common/server.ts'
import { region } from '#core/region.ts'
import { kanban } from './state.ts'
import type { KanbanServer } from '../kanban-common/server.ts'

// Assembled the way the root assembles it: the domain inside a region.
const make = (server: KanbanServer, pollMs: number) => {
  const box = region('kanban', () => kanban(server, pollMs))
  const app = box.value
  return {
    ...app,
    dispose: () => {
      app.dispose()
      box.dispose()
    },
  }
}

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const column = (app: ReturnType<typeof make>, id: string): readonly string[] =>
  app.state.layout.peek().find(c => c.id === id)?.cardIds ?? []

test('load fills the board', async () => {
  const app = make(kanbanServer({ latency: 3 }), 60_000)
  await app.actions.load()
  assert.deepEqual(
    app.state.layout.peek().map(c => c.id),
    ['backlog', 'progress', 'review', 'done'],
  )
  assert.equal(column(app, 'backlog').length, 9)
  assert.equal(app.state.cards.peek().size, 20)
  assert.equal(app.state.coldStart.peek(), false)
  app.dispose()
})

test('a refused move shows up instantly and retreats: the entry leaves, nothing else', async () => {
  const app = make(kanbanServer({ latency: 10, grumpiness: 1 }), 60_000)
  await app.actions.load()
  const before = column(app, 'backlog')
  const moved = before[2]
  assert.ok(moved !== undefined)

  const done = app.actions.move(moved, 'review', 0)
  assert.equal(column(app, 'review')[0], moved) // hope, no waiting
  assert.ok(app.state.busy.peek().has(moved))

  await done // the server refuses; the entry is discarded with a trace
  assert.deepEqual(column(app, 'backlog'), before)
  assert.equal(app.state.busy.peek().size, 0)
  assert.ok(app.state.refused.peek() !== null)
  app.dispose()
})

test('an accepted move stays: first held over the base, then absorbed by it', async () => {
  const app = make(kanbanServer({ latency: 3, grumpiness: 0 }), 60_000)
  await app.actions.load()
  const moved = column(app, 'backlog')[0]
  assert.ok(moved !== undefined)

  await app.actions.move(moved, 'progress', 1)
  assert.equal(column(app, 'progress')[1], moved) // confirmed, base still old
  assert.equal(app.state.busy.peek().size, 0)

  await app.actions.load() // the base catches up and absorbs the entry
  assert.equal(column(app, 'progress')[1], moved)
  assert.ok(!column(app, 'backlog').includes(moved))
  app.dispose()
})

test('polling follows demand and picks up the bot', async () => {
  const server = kanbanServer({ latency: 2, grumpiness: 0, botEvery: 15 })
  const stopBot = server.startBot()
  const app = make(server, 25)
  const stop = subscribe(app.state.layout, () => {})
  await wait(200)
  stopBot()
  const settledDown = app.state.layout.peek().flatMap(c => c.cardIds)
  assert.ok(settledDown.length > 0) // the look alone loaded and kept the board fresh
  stop()
  app.dispose()
})

test('fifth: a snapshot lands during an unfinished move — truth at once, the hope on top', async () => {
  const server = kanbanServer({ latency: 5, grumpiness: 0 })
  const app = make(server, 60_000)
  await app.actions.load()
  const ours = column(app, 'backlog')[0]
  const theirs = column(app, 'backlog')[1]
  assert.ok(ours !== undefined && theirs !== undefined)

  app.post.pause() // offline: our hope is written down, not sent
  const hoped = app.actions.move(ours, 'review', 0)
  assert.equal(column(app, 'review')[0], ours)

  await server.moveCard(theirs, 'done', 0) // somebody else edits the world
  await app.actions.load() // the snapshot arrives during our unfinished move

  assert.equal(column(app, 'done')[0], theirs) // truth landed immediately, no guard
  assert.equal(column(app, 'review')[0], ours) // the hope stayed on top
  assert.ok(!column(app, 'backlog').includes(ours))

  app.post.resume() // back online: the entry goes out
  await hoped
  await app.actions.load()
  assert.equal(column(app, 'review')[0], ours) // now it is the base's own word
  assert.equal(app.state.busy.peek().size, 0)
  app.dispose()
})

test('sixth: a lost reply retried under the same key makes one card, not two', async () => {
  const server = kanbanServer({ latency: 5, grumpiness: 0 })
  const app = make(server, 60_000)
  await app.actions.load()
  const before = app.state.cards.peek().size

  server.tripwire('addCard') // the work will happen; the answer will not arrive
  await app.actions.add('backlog', 'the law of the key')
  await wait(120) // the transient loss retries under the very same key

  await app.actions.load()
  assert.equal(app.state.cards.peek().size, before + 1) // one card, never two
  const backlog = column(app, 'backlog')
  const added = [...app.state.cards.peek().values()].find(c => c.title === 'the law of the key')
  assert.ok(added !== undefined)
  assert.equal(backlog.filter(id => id === added.id).length, 1)
  assert.equal(app.state.busy.peek().size, 0)
  app.dispose()
})
