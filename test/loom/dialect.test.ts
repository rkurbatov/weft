// The words of the dialect, each held to its law: the adjective, the key,
// the trace of a refusal, the void of assembly.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { stored } from '#weft'
import { laid, cell, notes, sends, truth, will } from '#loom'
import type { Entry } from '#weft'
import type { Channel as Wire } from '#weft'
import { wait } from '../kit/index.ts'

describe('the Loom dialect', () => {
  test('truth reads plain; flight, fault and asked stand beside as adjectives', async () => {
    let answer: () => void = () => {}
    const slow = new Promise<number>(resolve => {
      answer = () => resolve(42)
    })
    const t = truth(() => slow, { name: 't', empty: 0 })
    assert.equal(t.peek(), 0) // the empty shape, not a wrapper
    void t.refresh()
    await wait(1)
    assert.equal(t.flight.peek(), true)
    answer()
    await wait(1)
    assert.equal(t.peek(), 42)
    assert.equal(t.flight.peek(), false)
    assert.ok(t.asked.peek() > 0)
  })

  test('the key of the note reaches the sender; a refusal leaves a trace', async () => {
    const keys: string[] = []
    const post = will(
      {
        pay: sends<{ n: number }>((op, key) => {
          keys.push(key)
          return op.n < 0 ? Promise.reject(new Error('no: negative')) : Promise.resolve()
        }),
        told: notes<{ what: string }>(),
      },
      {
        name: 'w',
        judge: error =>
          error instanceof Error && error.message.startsWith('no') ? 'rejected' : 'transient',
      },
    )

    await post.pay({ n: 1 })
    assert.equal(keys.length, 1)
    assert.ok(keys[0] !== undefined && keys[0].length > 0)

    await post.pay({ n: -1 })
    assert.equal(post.refused.peek()?.error, 'no: negative') // silence is not an option

    post.told({ what: 'done elsewhere' }) // a fait accompli is born done
    assert.equal(post.notes.peek().at(-1)?.state, 'done')
  })

  test('laid assembles the void into nothing and keeps identity', () => {
    const base = {
      get: () => ({ items: [{ id: 'a' }, { id: 'b' }], order: ['a', 'b'] }),
      asked: stored(0),
    }
    const book = stored<readonly Entry[]>([])
    const post = { notes: book, absorb: () => {} }
    const seen = laid(base, post, {
      shape: {
        rows: s => s.items,
        key: r => r.id,
        lanes: s => [{ id: 'all', items: s.order }],
      },
      rules: {
        move: (b, op: { id: string; at: number }) => b.place(op.id, 'all', op.at),
      },
    })

    const before = seen.peek()
    book.set([
      { id: '1', name: 'move', args: { id: 'ghost', at: 0 }, at: 0, attempts: 0, state: 'waiting' },
    ])
    // The ghost has no subject: the placement assembles into nothing, silently.
    assert.deepEqual(seen.peek().lanes[0]?.items, ['a', 'b'])
    assert.equal(seen.peek(), before) // and nothing really changed: same object

    book.set([
      { id: '2', name: 'move', args: { id: 'b', at: 0 }, at: 0, attempts: 0, state: 'waiting' },
    ])
    assert.deepEqual(seen.peek().lanes[0]?.items, ['b', 'a'])

    const f = cell(1)
    assert.equal(f.peek(), 1) // fact is the graph's own word
  })

  test("the book is carried over: a dead leader's unsent note is delivered by the next", async () => {
    const { memoryStore } = await import('#weft')
    const shelf = memoryStore() // the shared shelf: what idb is to leaders
    const delivered: number[] = []

    // The first leader writes a note down and dies before sending it.
    const first = will(
      { pay: sends<{ n: number }>(() => Promise.reject(new Error('unreached'))) },
      { name: 'ledger', store: shelf },
    )
    first.pause() // held: written, not sent — and then the tab is gone
    void first.pay({ n: 7 })
    await wait(10) // let the book reach the shelf

    // The next leader rises over the same shelf and delivers what is owed.
    const second = will(
      {
        pay: sends<{ n: number }>(op => {
          delivered.push(op.n)
          return Promise.resolve()
        }),
      },
      { name: 'ledger', store: shelf },
    )
    await wait(20)
    assert.deepEqual(delivered, [7]) // the note survived its writer
    assert.equal(second.owed.peek(), 0)
    void second
  })

  test('the book outlives its leader: a new will on the same store delivers what is owed', async () => {
    const { memoryStore } = await import('#weft')
    const store = memoryStore()
    const sent: number[] = []
    const dictOf = () => ({
      pay: sends<{ n: number }>(op => {
        sent.push(op.n)
        return Promise.resolve()
      }),
    })

    const first = will(dictOf(), { name: 'book', store })
    first.pause() // the leader dies mid-silence: the entry is written, never sent
    void first.pay({ n: 7 })
    await wait(10)
    assert.equal(sent.length, 0)

    const second = will(dictOf(), { name: 'book', store }) // the next leader, same book
    await wait(20)
    assert.deepEqual(sent, [7]) // what was owed is delivered, not lost
    second.pause()
  })

  test('truth.suspend: a cold start throws the landing, anything held returns', async () => {
    let answer: (value: number) => void = () => {}
    const slow = new Promise<number>(resolve => {
      answer = resolve
    })
    const t = truth(() => slow, { name: 'susp', empty: 0 })

    let thrown: unknown
    try {
      t.suspend()
    } catch (landing) {
      thrown = landing
    }
    assert.ok(thrown instanceof Promise) // the cold start suspends

    answer(7)
    await thrown
    assert.equal(t.suspend(), 7) // held: returned plain, no throwing

    const sour = truth(() => Promise.reject(new Error('cold no')), { name: 'sour2', empty: 0 })
    try {
      sour.suspend()
    } catch (landing) {
      await landing
    }
    assert.throws(() => sour.suspend(), /cold no/) // a cold refusal goes to the boundary
  })

  test('carry: without talking tabs the station lives inline, and the mirror cannot tell', async () => {
    const { carry, adopt } = await import('#loom')
    const { kanbanServer } = await import('../../demo/kanban-common/server.ts')
    const { kanban } = await import('../../demo/kanban-weft/state.ts')
    const { serveKanban, kanbanMirror } = await import('../../demo/kanban-weft/mirror.ts')
    const { atOnce } = await import('#weft')
    void adopt

    const carried = carry(
      {
        name: 'kanban-carried',
        station: () => {
          const app = kanban(kanbanServer({ latency: 3, grumpiness: 0 }), 60_000)
          return {
            serve: channel => serveKanban(app, channel, { schedule: atOnce }),
            dispose: app.dispose,
          }
        },
      },
      { mode: 'inline' }, // stated, not sniffed: platforms grow locks
    )
    assert.equal(carried.role.peek(), 'inline')

    const tab = kanbanMirror(carried.channel)
    const { subscribe } = await import('#weft')
    const warm = subscribe(tab.state.cards, () => {})
    await tab.actions.load()
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(tab.state.cards.peek().size, 20)
    warm()
    tab.dispose()
    carried.stop()
  })

  test('carry: with talking tabs one leads and the others mirror it', async () => {
    const { carry, offer } = await import('#loom')
    const { link } = await import('#weft')
    const { atOnce } = await import('#weft')
    const { subscribe } = await import('#weft')
    const { heldOf } = await import('#weft')

    // A lock of our own: first asker holds, the next in line takes over.
    const lines = new Map<string, Array<() => void>>()
    const lock = {
      hold(name: string, onLead: () => void): () => void {
        const line = lines.get(name) ?? []
        lines.set(name, line)
        line.push(onLead)
        if (line.length === 1) onLead()
        return () => {
          const at = line.indexOf(onLead)
          if (at < 0) return
          line.splice(at, 1)
          if (at === 0) line[0]?.()
        }
      },
    }

    const station = () => {
      const n = cell(41, { name: 'n' })
      return { serve: (channel: Wire) => offer({ views: { n } }, channel, { schedule: atOnce }) }
    }
    const one = carry({ name: 'carried-tabs', station }, { mode: 'tabs', lock })
    const two = carry({ name: 'carried-tabs', station }, { mode: 'tabs', lock })
    await wait(1)
    assert.equal(one.role.peek(), 'leading')
    assert.equal(two.role.peek(), 'following')

    const wire = link(two.channel) // the follower mirrors the leader's station
    const face = wire.derived<number>('n')
    const warm = subscribe(face, () => {})
    await wait(5)
    assert.equal(heldOf(face.peek())?.value, 41)

    warm()
    wire.close()
    two.stop()
    one.stop()
  })

  test('the book states its shelf: memory here, and a given shelf is the caller’s', async () => {
    const { memoryStore } = await import('#weft')
    const plain = will({ ping: sends<number>(() => Promise.resolve()) }, { name: 'shelf.plain' })
    // No browser database in a test runner, so the best shelf here is memory —
    // and it says so rather than pretending the book outlives the tab.
    assert.equal(plain.shelf, 'memory')

    const given = will(
      { ping: sends<number>(() => Promise.resolve()) },
      { name: 'shelf.given', store: memoryStore() },
    )
    assert.equal(given.shelf, 'given')
  })

  test('a local change costs the size of the book, not the size of the board', () => {
    const cards = Array.from({ length: 2000 }, (_, i) => ({ id: `c${i}` }))
    const order = cards.map(c => c.id)
    const base = { get: () => ({ cards, order }), asked: stored(0) }
    const book = stored<readonly Entry[]>([])
    const seen = laid(
      base,
      { notes: book, absorb: () => {} },
      {
        shape: {
          rows: (s: { cards: Array<{ id: string }> }) => s.cards,
          key: r => r.id,
          lanes: (s: { order: string[] }) => [{ id: 'all', items: s.order }],
        },
        rules: { move: (b, op: { id: string; at: number }) => b.place(op.id, 'all', op.at) },
      },
    )

    const before = seen.peek()
    book.set([
      { id: '1', name: 'move', args: { id: 'c1999', at: 0 }, at: 0, attempts: 0, state: 'waiting' },
    ])
    const after = seen.peek()

    // The rows the book did not touch are the very same objects — not copies —
    // which is what the board of a real screen depends on.
    for (const id of ['c0', 'c1', 'c1000']) {
      assert.equal(after.rows.get(id), before.rows.get(id))
    }
    assert.equal(after.rows.size, before.rows.size)
    assert.equal(after.lanes[0]?.items[0], 'c1999', 'and the move itself landed')
  })
})
