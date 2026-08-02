// The shared kanban tests: six bodies, one text. Every carrier runs the very
// same tests with its own bench; `settle` is the bench's step of propagation —
// a breath in place, one crossing of the wire through a mirror. A carrier
// that cannot pass the suite unchanged is a wrong carrier, not a wrong suite.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subscribe } from '#core/graph.ts'
import type { KanbanServer } from '../kanban-common/server.ts'
import { kanbanServer } from '../kanban-common/server.ts'
import type { Kanban } from './state.ts'

export interface Bench {
  app: Kanban
  /** One step of propagation on this carrier. */
  settle(): Promise<void>
  dispose(): void
}

export type Make = (server: KanbanServer, pollMs: number) => Bench

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const column = (app: Kanban, id: string): readonly string[] =>
  app.state.layout.peek().find(c => c.id === id)?.cardIds ?? []

export function kanbanSuite(side: string, make: Make): void {
  test(`${side}: load fills the board`, async () => {
    const bench = make(kanbanServer({ latency: 3 }), 60_000)
    const { app } = bench
    await app.actions.load()
    await bench.settle()
    assert.deepEqual(
      app.state.layout.peek().map(c => c.id),
      ['backlog', 'progress', 'review', 'done'],
    )
    assert.equal(column(app, 'backlog').length, 9)
    assert.equal(app.state.cards.peek().size, 20)
    assert.equal(app.state.coldStart.peek(), false)
    bench.dispose()
  })

  test(`${side}: a refused move shows up instantly and retreats`, async () => {
    const bench = make(kanbanServer({ latency: 10, grumpiness: 1 }), 60_000)
    const { app } = bench
    await app.actions.load()
    await bench.settle()
    const before = column(app, 'backlog')
    const moved = before[2]
    assert.ok(moved !== undefined)

    const done = app.actions.move(moved, 'review', 0)
    await bench.settle()
    assert.equal(column(app, 'review')[0], moved) // hope, before the world answers
    assert.ok(app.state.busy.peek().has(moved))

    await done
    await bench.settle()
    assert.deepEqual(column(app, 'backlog'), before) // the note left; the picture retreated
    assert.equal(app.state.busy.peek().size, 0)
    assert.ok(app.state.refused.peek() !== null) // with a trace, never silently
    bench.dispose()
  })

  test(`${side}: an accepted move stays — held, then absorbed`, async () => {
    const bench = make(kanbanServer({ latency: 3, grumpiness: 0 }), 60_000)
    const { app } = bench
    await app.actions.load()
    await bench.settle()
    const moved = column(app, 'backlog')[0]
    assert.ok(moved !== undefined)

    await app.actions.move(moved, 'progress', 1)
    await bench.settle()
    assert.equal(column(app, 'progress')[1], moved) // confirmed, not yet absorbed
    assert.equal(app.state.busy.peek().size, 0)

    await app.actions.load()
    await bench.settle()
    assert.equal(column(app, 'progress')[1], moved) // absorbed: the base agrees
    assert.ok(!column(app, 'backlog').includes(moved))
    bench.dispose()
  })

  test(`${side}: polling follows demand and picks up the bot`, async () => {
    const server = kanbanServer({ latency: 2, grumpiness: 0, botEvery: 15 })
    const stopBot = server.startBot()
    const bench = make(server, 25)
    const stop = subscribe(bench.app.state.layout, () => {}) // the look is the demand
    await wait(250)
    stopBot()
    const settled = bench.app.state.layout.peek().flatMap(c => c.cardIds)
    assert.ok(settled.length > 0)
    stop()
    bench.dispose()
  })

  test(`${side}: fifth — a snapshot lands during an unfinished move`, async () => {
    const server = kanbanServer({ latency: 5, grumpiness: 0 })
    const bench = make(server, 60_000)
    const { app } = bench
    await app.actions.load()
    await bench.settle()
    const ours = column(app, 'backlog')[0]
    const theirs = column(app, 'backlog')[1]
    assert.ok(ours !== undefined && theirs !== undefined)

    app.post.pause() // the tunnel
    const hoped = app.actions.move(ours, 'review', 0)
    await bench.settle()
    assert.equal(column(app, 'review')[0], ours)

    await server.moveCard(theirs, 'done', 0) // somebody else's hand
    await app.actions.load()
    await bench.settle()
    assert.equal(column(app, 'done')[0], theirs) // their news arrived
    assert.equal(column(app, 'review')[0], ours) // our hope did not flinch
    assert.ok(!column(app, 'backlog').includes(ours))

    app.post.resume()
    await hoped
    await app.actions.load()
    await bench.settle()
    assert.equal(column(app, 'review')[0], ours)
    assert.equal(app.state.busy.peek().size, 0)
    bench.dispose()
  })

  test(`${side}: sixth — a lost reply retried under the same key makes one card`, async () => {
    const server = kanbanServer({ latency: 5, grumpiness: 0 })
    const bench = make(server, 60_000)
    const { app } = bench
    await app.actions.load()
    await bench.settle()
    const before = app.state.cards.peek().size

    server.tripwire('addCard') // the work will happen; the answer will not arrive
    await app.actions.add('backlog', 'the law of the key')
    await wait(120) // the transient loss retries under the very same key
    await app.actions.load()
    await bench.settle()
    assert.equal(app.state.cards.peek().size, before + 1) // one card, never two
    assert.equal(app.state.busy.peek().size, 0)
    bench.dispose()
  })
}
