// The same screen in two tabs, end to end.
//
// The other whole-screen test judges one tab: a load, a change before the
// server answers, a refusal. This one judges the promise that only shows up
// with a second tab — that where state lives is a deployment decision, not a
// rewrite. The screen code is the same either way; what differs is that one
// tab carries the state and the other watches a mirror of it.
//
// Nothing here reaches inside anything. If a step cannot be said with the
// words the dialect offers, that is the finding.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { adopt, offer, sends, truth, will } from '#loom'
import { memoryStore, subscribe, wirePair } from '#weft'
import { settle, until, world } from '#testkit'

interface Task {
  id: string
  lane: string
}

/** A server both tabs would share, if the second tab could see it at all. */
function fakeServer() {
  const tasks = new Map<string, Task>([['a', { id: 'a', lane: 'todo' }]])
  let moves = 0
  return {
    moves: () => moves,
    snapshot: (): Promise<Task[]> => Promise.resolve([...tasks.values()]),
    move(op: { id: string; lane: string }): Promise<void> {
      moves++
      const task = tasks.get(op.id)
      if (task === undefined) return Promise.reject(new Error('no such task'))
      tasks.set(op.id, { ...task, lane: op.lane })
      return Promise.resolve()
    },
  }
}

/** The station: the tab that holds the state and talks to the server. */
function station(server: ReturnType<typeof fakeServer>, clock: ReturnType<typeof world>) {
  const board = truth(() => server.snapshot(), {
    name: 'board',
    timers: clock.timers,
    empty: [],
  })
  const intent = will(
    { move: sends((op: { id: string; lane: string }) => server.move(op)) },
    { name: 'intent', store: memoryStore(), timers: clock.timers },
  )
  return { board, intent }
}

describe('two tabs, one state', () => {
  test('the second tab sees the board without ever meeting the server', async () => {
    const clock = world()
    const server = fakeServer()
    const wire = wirePair()
    const held = station(server, clock)

    until(offer({ views: { board: held.board }, acts: { move: held.intent.move } }, wire.graph))
    const watcher = adopt(wire.watcher)
    until(watcher.close)

    const shown = watcher.view<Task[]>('board')
    until(subscribe(shown, () => {}))
    await settle(3)

    assert.deepEqual(
      shown.peek()?.map(t => t.lane),
      ['todo'],
    )
    assert.equal(server.moves(), 0, 'and it asked the server nothing: it has no server')
  })

  test('an act travels from the watching tab and lands in the other one', async () => {
    const clock = world()
    const server = fakeServer()
    const wire = wirePair()
    const held = station(server, clock)

    until(offer({ views: { board: held.board }, acts: { move: held.intent.move } }, wire.graph))
    const watcher = adopt(wire.watcher)
    until(watcher.close)

    const shown = watcher.view<Task[]>('board')
    until(subscribe(shown, () => {}))
    await settle(3)

    // The screen of the watching tab does what any screen does — and the state
    // it changes is not in this tab at all.
    void watcher.act<[{ id: string; lane: string }]>('move')({ id: 'a', lane: 'done' })
    await clock.advance(1)
    await settle(3)

    assert.equal(server.moves(), 1, 'the station talked to the server, not the watcher')

    // A confirmed act does not rewrite the truth by itself — the world is
    // asked again, and that is where the new value comes from.
    await held.board.refresh()
    await settle(3)
    assert.deepEqual(
      held.board.peek().map(t => t.lane),
      ['done'],
    )
    assert.deepEqual(
      shown.peek()?.map(t => t.lane),
      ['done'],
      'and the mirror caught up',
    )
  })

  test('a tab that stops looking stops being served', async () => {
    const clock = world()
    const server = fakeServer()
    const wire = wirePair()
    const held = station(server, clock)

    until(offer({ views: { board: held.board } }, wire.graph))
    const watcher = adopt(wire.watcher)
    until(watcher.close)

    const shown = watcher.view<Task[]>('board')
    const stop = subscribe(shown, () => {})
    await settle(3)
    assert.deepEqual(
      shown.peek()?.map(t => t.lane),
      ['todo'],
    )

    stop()
    await settle(3)
    // A mirror nobody looks at forgets: unknown is honest, stale is not.
    assert.equal(shown.peek(), undefined)
  })
})
