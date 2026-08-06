import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { derived, subscribe } from '#graph'
import { outbox } from '#keep'
import { memoryStore } from '#keep'
import type { Note, Handler } from '#keep'
import { settle, until, world } from '#testkit'

describe('the outbox', () => {
  function ids() {
    let n = 0
    return () => `id-${++n}`
  }

  test('a command is sent with its idempotency key and then leaves the book', async () => {
    const clock = world()
    const store = memoryStore()
    const seen: Array<{ args: unknown; key: string; attempt: number }> = []
    const book = outbox({
      key: 'out',
      store,
      now: clock.now,
      timers: clock.timers,
      newId: ids(),
      handlers: {
        pay: (async (args: unknown, handling) => {
          seen.push({ args, key: handling.key, attempt: handling.attempt })
        }) as Handler,
      },
    })
    const { id, done } = book.send('pay', { amount: 10 })
    assert.equal(book.owed.peek(), 1)
    await done
    assert.deepEqual(seen, [{ args: { amount: 10 }, key: id, attempt: 1 }])
    assert.equal(book.owed.peek(), 0)
    assert.deepEqual(await store.read('out'), [])
  })

  test('commands go one at a time, in the order they were written down', async () => {
    const clock = world()
    const store = memoryStore()
    const order: string[] = []
    let releaseFirst!: () => void
    const first = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const book = outbox({
      key: 'out',
      store,
      now: clock.now,
      timers: clock.timers,
      newId: ids(),
      handlers: {
        slow: (async () => {
          order.push('slow start')
          await first
          order.push('slow end')
        }) as Handler,
        quick: (async () => {
          order.push('quick')
        }) as Handler,
      },
    })
    book.send('slow', {})
    const second = book.send('quick', {})
    await settle()
    assert.deepEqual(order, ['slow start'])
    releaseFirst()
    await second.done
    assert.deepEqual(order, ['slow start', 'slow end', 'quick'])
  })

  test('what was in flight when the tab died is sent again with the same key', async () => {
    const store = memoryStore()
    const clock = world()
    // A previous run wrote it down and died mid-send.
    await store.write('out', [
      { id: 'kept-key', name: 'pay', args: { amount: 5 }, at: 900, attempts: 1, state: 'sending' },
    ] satisfies Note[])
    const seen: Array<{ key: string; attempt: number }> = []
    const book = outbox({
      key: 'out',
      store,
      now: clock.now,
      timers: clock.timers,
      handlers: {
        pay: (async (_args: unknown, handling) => {
          seen.push({ key: handling.key, attempt: handling.attempt })
        }) as Handler,
      },
    })
    await book.ready
    await settle()
    assert.deepEqual(seen, [{ key: 'kept-key', attempt: 2 }])
    assert.equal(book.owed.peek(), 0)
  })

  test('a refusal is retried with growing waits, keeping the key', async () => {
    const clock = world()
    const store = memoryStore()
    const attempts: number[] = []
    let calls = 0
    const book = outbox({
      key: 'out',
      store,
      retry: 100,
      now: clock.now,
      timers: clock.timers,
      newId: ids(),
      handlers: {
        flaky: (async (_args: unknown, handling) => {
          attempts.push(handling.attempt)
          calls++
          if (calls < 3) throw new Error('busy')
        }) as Handler,
      },
    })
    const { id, done } = book.send('flaky', {})
    await settle()
    assert.deepEqual(attempts, [1])
    await clock.advance(100)
    assert.deepEqual(attempts, [1, 2])
    await clock.advance(150) // the second wait is 200
    assert.deepEqual(attempts, [1, 2])
    await clock.advance(100)
    await done
    assert.deepEqual(attempts, [1, 2, 3])
    assert.equal(book.owed.peek(), 0)
    assert.equal(id.length > 0, true)
  })

  test('after enough failures it gets stuck and waits for a person', async () => {
    const clock = world()
    const store = memoryStore()
    const stuck: Note[] = []
    let calls = 0
    const book = outbox({
      key: 'out',
      store,
      retry: 100,
      maxAttempts: 3,
      now: clock.now,
      timers: clock.timers,
      newId: ids(),
      onStuck: entry => stuck.push(entry),
      handlers: {
        doomed: (async () => {
          calls++
          throw new Error('nope')
        }) as Handler,
      },
    })
    const { done } = book.send('doomed', {})
    const rejected = assert.rejects(done, /nope/)
    await settle()
    await clock.advance(1000)
    await rejected
    assert.equal(calls, 3)
    assert.equal(book.owed.peek(), 0) // owed counts what is still trying
    assert.equal(book.stuck.peek().length, 1)
    assert.equal(stuck.length, 1)
    assert.equal(stuck[0]?.lastError, 'nope')
    await clock.advance(10_000)
    assert.equal(calls, 3) // it stopped by itself
  })

  test('a stuck entry can be tried again or dropped', async () => {
    const clock = world()
    const store = memoryStore()
    let works = false
    let calls = 0
    const book = outbox({
      key: 'out',
      store,
      retry: 100,
      maxAttempts: 1,
      now: clock.now,
      timers: clock.timers,
      newId: ids(),
      handlers: {
        later: (async () => {
          calls++
          if (!works) throw new Error('not yet')
        }) as Handler,
      },
    })
    const { id, done } = book.send('later', {})
    await assert.rejects(done, /not yet/)
    assert.equal(book.stuck.peek().length, 1)

    works = true
    book.again(id)
    await settle()
    assert.equal(calls, 2)
    assert.equal(book.stuck.peek().length, 0)
    assert.equal(book.owed.peek(), 0)

    const dropped = book.send('later', {})
    book.forget(dropped.id)
    await assert.rejects(dropped.done, /discarded by hand/)
    assert.equal(book.entries.peek().length, 0)
  })

  test('an entry whose handler is unknown gets stuck instead of vanishing', async () => {
    const store = memoryStore()
    const clock = world()
    await store.write('out', [
      { id: 'orphan', name: 'gone', args: {}, at: 900, attempts: 0, state: 'waiting' },
    ] satisfies Note[])
    const book = outbox({ key: 'out', store, now: clock.now, timers: clock.timers, handlers: {} })
    await book.ready
    await settle()
    const stuck = book.stuck.peek()
    assert.equal(stuck.length, 1)
    assert.match(String(stuck[0]?.lastError), /no handler/)
    assert.equal(book.entries.peek().length, 1) // still on the books
  })

  test('a paused book holds everything until it is resumed', async () => {
    const clock = world()
    const store = memoryStore()
    let calls = 0
    const book = outbox({
      key: 'out',
      store,
      paused: true,
      now: clock.now,
      timers: clock.timers,
      newId: ids(),
      handlers: {
        send: (async () => {
          calls++
        }) as Handler,
      },
    })
    const { done } = book.send('send', {})
    await settle()
    assert.equal(calls, 0)
    assert.equal(book.owed.peek(), 1)
    book.resume()
    await done
    assert.equal(calls, 1)
    assert.equal(book.owed.peek(), 0)
  })

  test('what is owed is a cell: a screen can depend on it', async () => {
    const clock = world()
    const store = memoryStore()
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const book = outbox({
      key: 'out',
      store,
      now: clock.now,
      timers: clock.timers,
      newId: ids(),
      handlers: {
        slow: (async () => {
          await held
        }) as Handler,
      },
    })
    const label = derived(() => (book.owed.get() === 0 ? 'saved' : `${book.owed.get()} unsent`))
    const seen: string[] = []
    until(subscribe(label, value => seen.push(value)))
    const { done } = book.send('slow', {})
    assert.equal(label.peek(), '1 unsent')
    release()
    await done
    assert.equal(label.peek(), 'saved')
    assert.deepEqual(seen, ['1 unsent', 'saved'])
  })

  test('an unknown outcome never counts toward poison: the entry is repeated as a matter of course', async () => {
    const clock = world()
    const store = memoryStore()
    const seen: number[] = []
    let outcome: 'silence' | 'refusal' | 'taken' = 'silence'
    const unknown = () => {
      const error = new Error('sent, no answer')
      error.name = 'Unknown'
      return error
    }
    const book = outbox({
      key: 'out',
      store,
      now: clock.now,
      timers: clock.timers,
      retry: 100,
      maxAttempts: 2,
      handlers: {
        pay: async (_args, handling) => {
          seen.push(handling.attempt)
          if (outcome === 'silence') throw unknown()
          if (outcome === 'refusal') throw new Error('the world says no')
        },
      },
    })
    await book.ready
    const { done } = book.send('pay', { amount: 5 })
    done.catch(() => {})
    await settle()

    // Silence upon silence, far past maxAttempts — and nothing is stuck.
    await clock.advance(10_000)
    assert.ok(seen.length > 4)
    assert.equal(book.stuck.peek().length, 0)

    // Real refusals, and the poison count starts moving: two are enough.
    outcome = 'refusal'
    await clock.advance(10_000)
    assert.equal(book.stuck.peek().length, 1)
  })

  test('discarding leaves a trace through the same door as success', async () => {
    const clock = world()
    const store = memoryStore()
    const discarded: string[] = []
    const book = outbox({
      key: 'out',
      store,
      now: clock.now,
      timers: clock.timers,
      paused: true,
      handlers: { pay: async () => {} },
      onDiscarded: entry => discarded.push(`${entry.name}: ${entry.lastError ?? ''}`),
    })
    await book.ready
    const { id, done } = book.send('pay', { amount: 5 })
    const refused = assert.rejects(done, /discarded by hand/)
    await settle()
    book.forget(id)
    await refused
    assert.deepEqual(discarded, ['pay: discarded by hand'])
    assert.equal(book.entries.peek().length, 0)
  })

  test('a permanent refusal discards the entry at once, with a trace', async () => {
    const clock = world()
    const refusals: Note[] = []
    const calls: string[] = []
    const box = outbox({
      key: 'k',
      store: memoryStore(),
      handlers: {
        pay: (args => {
          calls.push(String((args as { n: number }).n))
          return Promise.reject(new Error('conflict: no such account'))
        }) as Handler,
      },
      classify: error =>
        error instanceof Error && error.message.startsWith('conflict') ? 'rejected' : 'transient',
      timers: clock.timers,
      now: clock.now,
      onRefused: entry => refusals.push(entry),
    })
    await box.ready

    const { done } = box.send('pay', { n: 1 })
    await clock.advance(1)
    await assert.rejects(done)
    assert.deepEqual(calls, ['1']) // one ask, no retries: the no was meaningful
    assert.equal(box.entries.peek().length, 0)
    assert.equal(refusals.length, 1)
    assert.match(refusals[0]?.lastError ?? '', /conflict/)

    // And the no is final: a second refused entry leaves the same way, and the
    // clock holds nothing to retry. (Transient retries are covered above.)
    const { done: second } = box.send('pay', { n: 2 })
    await clock.advance(1)
    await assert.rejects(second)
    await clock.advance(1000)
    assert.deepEqual(calls, ['1', '2'])
    assert.equal(box.entries.peek().length, 0)
  })

  test('a retained note stays done until the base absorbs it; a fait accompli is born done', async () => {
    const clock = world()
    const box = outbox({
      key: 'k',
      store: memoryStore(),
      handlers: { move: (() => Promise.resolve()) as Handler },
      retain: true,
      timers: clock.timers,
      now: clock.now,
    })
    await box.ready

    const { done } = box.send('move', { id: 'c1' })
    await clock.advance(1)
    await done
    const held = box.entries.peek()[0]
    assert.equal(held?.state, 'done') // confirmed, not absorbed: still in the book
    assert.equal(box.owed.peek(), 0) // but owed to nobody
    assert.equal(box.active.peek().length, 1) // and still laying over the base

    const noted = box.note('add', { id: 'c2' })
    assert.equal(box.entries.peek().length, 2)
    assert.equal(box.entries.peek()[1]?.state, 'done')
    assert.ok(noted.id.length > 0)

    box.absorb(clock.now() - 1000) // a snapshot older than both: absorbs nothing
    assert.equal(box.entries.peek().length, 2)
    box.absorb(clock.now()) // the base caught up
    assert.equal(box.entries.peek().length, 0)
  })

  test('note() without retain is refused loudly', async () => {
    const clock = world()
    const box = outbox({
      key: 'k',
      store: memoryStore(),
      handlers: {},
      timers: clock.timers,
      now: clock.now,
    })
    await box.ready
    assert.throws(() => box.note('add', {}), /needs retain/)
  })

  test('a lane held up by a refusal does not hold up the others', async () => {
    const clock = world()
    const sent: string[] = []
    let analyticsUp = false
    const box = outbox({
      key: 'k',
      store: memoryStore(),
      handlers: {
        track: () => {
          if (analyticsUp) {
            sent.push('track')
            return Promise.resolve()
          }
          return Promise.reject(new Error('analytics is down'))
        },
        save: (args: unknown) => {
          sent.push(`save:${String((args as { doc: string }).doc)}`)
          return Promise.resolve()
        },
      },
      retry: 1000,
      timers: clock.timers,
      now: clock.now,
    })
    await box.ready

    // The slow, broken thing is written first — in one queue it would hold
    // everything behind it for as long as it keeps failing.
    box.send('track', { event: 'opened' }, { lane: 'analytics' })
    box.send('save', { doc: 'a' })
    box.send('save', { doc: 'b' })
    await clock.advance(1)

    assert.deepEqual(sent, ['save:a', 'save:b'], 'the documents went while analytics kept failing')
    assert.equal(box.owed.peek(), 1, 'the analytics note is still owed')

    // And when it comes back, its own lane carries on where it stopped.
    analyticsUp = true
    await clock.advance(5000)
    assert.deepEqual(sent, ['save:a', 'save:b', 'track'])
    assert.equal(box.owed.peek(), 0)
  })

  test('order still holds within a lane', async () => {
    const clock = world()
    const sent: string[] = []
    const box = outbox({
      key: 'k',
      store: memoryStore(),
      handlers: {
        step: (args: unknown) => {
          sent.push(String((args as { n: number }).n))
          return Promise.resolve()
        },
      },
      timers: clock.timers,
      now: clock.now,
    })
    await box.ready

    for (const n of [1, 2, 3]) box.send('step', { n }, { lane: 'one' })
    await clock.advance(1)
    assert.deepEqual(sent, ['1', '2', '3'])
  })
})
