// The shared tests again — through the mirror. One station holds the domain,
// tabs watch it over a cloning boundary; the tests cannot tell. Plus the
// carrier's own law: two tabs, one state.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { region } from '#weft'
import { subscribe } from '#weft'
import type { Watchable } from '#weft'
import { atOnce } from '#weft'
import { pairInMemory } from '#weft'
import { kanbanServer } from '../kanban-common/server.ts'
import { kanban } from './state.ts'
import { kanbanMirror, serveKanban } from './mirror.ts'
import { kanbanSuite } from './suite.ts'
import type { Make } from './suite.ts'
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

const bench: Make = (server, pollMs) => {
  const made = make(server, pollMs)
  return {
    app: made,
    settle: () => new Promise(resolve => setTimeout(resolve, 2)), // one crossing of the wire
    dispose: made.dispose,
  }
}

kanbanSuite('through the mirror', bench)

const column = (
  app: { state: { layout: { peek(): { id: string; cardIds: string[] }[] } } },
  id: string,
): readonly string[] => app.state.layout.peek().find(c => c.id === id)?.cardIds ?? []

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

test('the law of the key on the tab seam: a repeat under one key is one note, one card', async () => {
  const server = kanbanServer({ latency: 4, grumpiness: 0 })
  const app = make(server, 60_000)
  await app.actions.load()
  await wait(1)
  const before = app.state.cards.peek().size

  const key = 'tab-add-1'
  // The tab does not know whether its first call landed — it repeats by key.
  await Promise.all([
    app.actions.add('backlog', 'once only', key),
    app.actions.add('backlog', 'once only', key),
  ])
  await wait(30)
  await app.actions.load()
  await wait(1)
  assert.equal(app.state.cards.peek().size, before + 1) // one key — one card
  app.dispose()
})
