// The words of the dialect, each held to its law: the adjective, the key,
// the trace of a refusal, the void of assembly.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { input } from '#core/graph.ts'
import { fact, laid, notes, sends, truth, will } from '#loom'
import type { Entry } from '#core/outbox.ts'

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

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
  assert.equal(post.entries.peek().at(-1)?.state, 'done')
})

test('laid assembles the void into nothing and keeps identity', () => {
  const base = {
    get: () => ({ items: [{ id: 'a' }, { id: 'b' }], order: ['a', 'b'] }),
    asked: input(0),
  }
  const book = input<readonly Entry[]>([])
  const post = { entries: book, absorb: () => {} }
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

  const f = fact(1)
  assert.equal(f.peek(), 1) // fact is the graph's own word
})
