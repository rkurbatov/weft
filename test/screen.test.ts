// One screen, end to end.
//
// Every other test in this repository judges a package. This one judges the
// whole: a screen that loads from a server, changes something before the
// server has answered, survives a refusal, and is watched from a second tab —
// all through the dialect, the way an application writes it.
//
// It lives outside the packages on purpose. Nothing here reaches inside
// anything: if a step cannot be written with the words the dialect offers,
// that is the finding, not a reason to import deeper.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { laid, sends, truth, will } from '#loom'
import { memoryStore, subscribe } from '#weft'
import { settle, until, world } from '#testkit'

interface Task {
  id: string
  title: string
  lane: string
}

interface Board {
  tasks: Task[]
  order: Record<string, string[]>
}

/** A server that answers, refuses, or holds its answer until told. */
function fakeServer() {
  const tasks = new Map<string, Task>([
    ['a', { id: 'a', title: 'write it down', lane: 'todo' }],
    ['b', { id: 'b', title: 'read it back', lane: 'todo' }],
  ])
  let refusing = false
  let asked = 0

  return {
    asked: () => asked,
    refuse: (yes: boolean) => {
      refusing = yes
    },
    snapshot(): Promise<Board> {
      asked++
      const order: Record<string, string[]> = { todo: [], done: [] }
      for (const task of tasks.values()) order[task.lane]?.push(task.id)
      return Promise.resolve({ tasks: [...tasks.values()], order })
    },
    move(op: { id: string; lane: string }): Promise<void> {
      if (refusing) return Promise.reject(new Error('the server said no'))
      const task = tasks.get(op.id)
      if (task === undefined) return Promise.reject(new Error('no such task'))
      tasks.set(op.id, { ...task, lane: op.lane })
      return Promise.resolve()
    },
  }
}

/** The screen, written the way an application would write it. */
function screen(server: ReturnType<typeof fakeServer>, clock: ReturnType<typeof world>) {
  const board = truth(() => server.snapshot(), {
    name: 'board',
    poll: 1000,
    timers: clock.timers,
    // What a screen shows before the first answer arrives.
    empty: { tasks: [], order: { todo: [], done: [] } },
  })

  const intent = will(
    { move: sends((op: { id: string; lane: string }) => server.move(op)) },
    {
      name: 'board-intent',
      store: memoryStore(),
      timers: clock.timers,
      // A refusal by the server is final: no point repeating it.
      judge: () => 'permanent',
    },
  )

  const seen = laid(board, intent, {
    name: 'board-seen',
    shape: {
      rows: (snapshot: Board) => snapshot.tasks,
      key: (task: Task) => task.id,
      lanes: (snapshot: Board) =>
        Object.entries(snapshot.order).map(([id, items]) => ({ id, items })),
    },
    rules: {
      move: (put, op: { id: string; lane: string }) => put.place(op.id, op.lane, 'end'),
    },
  })

  return { board, intent, seen }
}

const laneOf = (
  seen: {
    peek(): { lanes: readonly { readonly id: string; readonly items: readonly string[] }[] }
  },
  id: string,
): string | undefined => seen.peek().lanes.find(lane => lane.items.includes(id))?.id

describe('a screen, end to end', () => {
  test('loads, changes before the server answers, and settles on the truth', async () => {
    const clock = world()
    const server = fakeServer()
    const app = screen(server, clock)
    until(subscribe(app.seen, () => {}))
    await settle(2)

    // What the server said.
    assert.equal(app.seen.peek().rows.size, 2)
    assert.equal(laneOf(app.seen, 'a'), 'todo')

    // A change, seen before the server has heard of it.
    app.intent.move({ id: 'a', lane: 'done' })
    assert.equal(laneOf(app.seen, 'a'), 'done', 'shown at once, on the strength of the intent')
    assert.equal(app.intent.owed.peek(), 1)

    // The server confirms, the note leaves the queue, and the picture does not
    // flinch: what it showed on its own account is now what the server says.
    await clock.advance(1)
    await settle(2)
    assert.equal(app.intent.owed.peek(), 0)
    assert.equal(laneOf(app.seen, 'a'), 'done')

    // And the next poll brings the same answer back, without moving anything.
    await clock.advance(1000)
    await settle(2)
    assert.equal(laneOf(app.seen, 'a'), 'done')
    assert.ok(server.asked() >= 2)
  })

  test('a refusal puts it back, without a line of rollback anywhere', async () => {
    const clock = world()
    const server = fakeServer()
    const app = screen(server, clock)
    until(subscribe(app.seen, () => {}))
    await settle(2)

    server.refuse(true)
    app.intent.move({ id: 'b', lane: 'done' })
    assert.equal(laneOf(app.seen, 'b'), 'done', 'shown while it is still owed')

    await clock.advance(1)
    await settle(3)

    assert.equal(laneOf(app.seen, 'b'), 'todo', 'the intent is gone, so the overlay is gone')
    assert.equal(app.intent.refused.peek()?.kind, 'move', 'and the screen is told why')
  })

  test('nobody watching, nothing asked', async () => {
    const clock = world()
    const server = fakeServer()
    const app = screen(server, clock)

    const stop = subscribe(app.seen, () => {})
    await settle(2)
    const asked = server.asked()
    assert.ok(asked > 0)

    stop()
    await clock.advance(5000)
    await settle(2)
    assert.equal(server.asked(), asked, 'the poll stopped with the last look')
  })
})
