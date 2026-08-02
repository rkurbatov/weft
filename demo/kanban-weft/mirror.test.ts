// The six trials again — through the mirror. One station holds the domain,
// tabs watch it over a cloning boundary; the trials cannot tell. Plus the
// carrier's own law: two tabs, one state.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { region } from '#core/region.ts'
import { subscribe } from '#core/graph.ts'
import type { Watchable } from '#core/graph.ts'
import { atOnce } from '../../src/link/channel.ts'
import { pairInMemory } from '../../src/link/ports.ts'
import { kanbanServer } from '../kanban-common/server.ts'
import { kanban } from './state.ts'
import { kanbanMirror, serveKanban } from './mirror.ts'
import type { KanbanServer } from '../kanban-common/server.ts'

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// The station and its tabs, across a structured-clone boundary. Every view is
// warmed for the trial's lifetime — what a mounted screen would do.
const make = (server: KanbanServer, pollMs: number, tabs = 1) => {
  const box = region('station', () => kanban(server, pollMs))
  const stops: Array<() => void> = []
  const mirrors = Array.from({ length: tabs }, () => {
    const pair = pairInMemory()
    stops.push(serveKanban(box.value, pair.graph, { schedule: atOnce }))
    const tab = kanbanMirror(pair.watcher)
    const warm: ReadonlyArray<Watchable<unknown>> = [
      tab.state.layout,
      tab.state.cards,
      tab.state.busy,
      tab.state.addBusy,
      tab.state.refused,
      tab.state.coldStart,
    ]
    for (const face of warm) stops.push(subscribe(face, () => {}))
    return tab
  })
  const app = mirrors[0] as ReturnType<typeof kanbanMirror>
  return {
    ...app,
    tabs: mirrors,
    dispose: () => {
      for (const stop of stops) stop()
      for (const tab of mirrors) tab.dispose()
      box.value.dispose()
      box.dispose()
    },
  }
}

const column = (
  app: { state: { layout: { peek(): { id: string; cardIds: string[] }[] } } },
  id: string,
): readonly string[] => app.state.layout.peek().find(c => c.id === id)?.cardIds ?? []

test('load fills the board — through the mirror', async () => {
  const app = make(kanbanServer({ latency: 3 }), 60_000)
  await app.actions.load()
  await wait(1)
  assert.deepEqual(
    app.state.layout.peek().map(c => c.id),
    ['backlog', 'progress', 'review', 'done'],
  )
  assert.equal(column(app, 'backlog').length, 9)
  assert.equal(app.state.cards.peek().size, 20)
  assert.equal(app.state.coldStart.peek(), false)
  app.dispose()
})

test('a refused move shows up instantly and retreats — through the mirror', async () => {
  const app = make(kanbanServer({ latency: 10, grumpiness: 1 }), 60_000)
  await app.actions.load()
  await wait(1)
  const before = column(app, 'backlog')
  const moved = before[2]
  assert.ok(moved !== undefined)

  const done = app.actions.move(moved, 'review', 0)
  await wait(1) // one crossing of the wire
  assert.equal(column(app, 'review')[0], moved)
  assert.ok(app.state.busy.peek().has(moved))

  await done
  await wait(1)
  assert.deepEqual(column(app, 'backlog'), before)
  assert.equal(app.state.busy.peek().size, 0)
  assert.ok(app.state.refused.peek() !== null)
  app.dispose()
})

test('an accepted move stays: held, then absorbed — through the mirror', async () => {
  const app = make(kanbanServer({ latency: 3, grumpiness: 0 }), 60_000)
  await app.actions.load()
  await wait(1)
  const moved = column(app, 'backlog')[0]
  assert.ok(moved !== undefined)

  await app.actions.move(moved, 'progress', 1)
  await wait(1)
  assert.equal(column(app, 'progress')[1], moved)
  assert.equal(app.state.busy.peek().size, 0)

  await app.actions.load()
  await wait(1)
  assert.equal(column(app, 'progress')[1], moved)
  assert.ok(!column(app, 'backlog').includes(moved))
  app.dispose()
})

test('polling follows demand across the boundary and picks up the bot', async () => {
  const server = kanbanServer({ latency: 2, grumpiness: 0, botEvery: 15 })
  const stopBot = server.startBot()
  const app = make(server, 25)
  await wait(250)
  stopBot()
  const settled = app.state.layout.peek().flatMap(c => c.cardIds)
  assert.ok(settled.length > 0) // a look in the tab kept the station's truth fresh
  app.dispose()
})

test('fifth: a snapshot lands during an unfinished move — through the mirror', async () => {
  const server = kanbanServer({ latency: 5, grumpiness: 0 })
  const app = make(server, 60_000)
  await app.actions.load()
  await wait(1)
  const ours = column(app, 'backlog')[0]
  const theirs = column(app, 'backlog')[1]
  assert.ok(ours !== undefined && theirs !== undefined)

  app.post.pause()
  const hoped = app.actions.move(ours, 'review', 0)
  await wait(1)
  assert.equal(column(app, 'review')[0], ours)

  await server.moveCard(theirs, 'done', 0)
  await app.actions.load()
  await wait(1)
  assert.equal(column(app, 'done')[0], theirs)
  assert.equal(column(app, 'review')[0], ours)
  assert.ok(!column(app, 'backlog').includes(ours))

  app.post.resume()
  await hoped
  await app.actions.load()
  await wait(1)
  assert.equal(column(app, 'review')[0], ours)
  assert.equal(app.state.busy.peek().size, 0)
  app.dispose()
})

test('sixth: the law of the key holds across the boundary', async () => {
  const server = kanbanServer({ latency: 5, grumpiness: 0 })
  const app = make(server, 60_000)
  await app.actions.load()
  await wait(1)
  const before = app.state.cards.peek().size

  server.tripwire('addCard')
  await app.actions.add('backlog', 'the law of the key')
  await wait(120)
  await app.actions.load()
  await wait(1)
  assert.equal(app.state.cards.peek().size, before + 1)
  app.dispose()
})

test('two tabs, one state', async () => {
  const server = kanbanServer({ latency: 3, grumpiness: 0 })
  const app = make(server, 60_000, 2)
  const [one, two] = app.tabs
  assert.ok(one !== undefined && two !== undefined)
  await one.actions.load()
  await wait(1)
  assert.equal(two.state.cards.peek().size, 20) // the other tab sees without asking

  const moved = column(one, 'backlog')[0]
  assert.ok(moved !== undefined)
  await one.actions.move(moved, 'progress', 0)
  await wait(1)
  assert.equal(column(two, 'progress')[0], moved) // one hope, every mirror
  app.dispose()
})

test("instruments cross the wire: the tab sees the station's waves", async () => {
  const { adopt } = await import('#loom')
  const server = kanbanServer({ latency: 3, grumpiness: 0 })
  const box = region('station', () => kanban(server, 60_000))
  const pair = pairInMemory()
  const stop = serveKanban(box.value, pair.graph, { schedule: atOnce, instruments: true })
  const tab = adopt(pair.watcher)
  const waves = tab.view<readonly { id: number }[]>('loom.waves')
  const warm = subscribe(waves, () => {})

  await box.value.actions.load()
  await wait(5)
  assert.ok((waves.peek() ?? []).length > 0) // the load's own waves, mirrored

  warm()
  tab.close()
  stop()
  box.value.dispose()
  box.dispose()
})
