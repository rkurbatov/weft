import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cell, subscribe } from '#weft/core/graph/graph.ts'
import { outbox } from '#weft/core/keep/outbox.ts'
import { memoryStore } from '#weft/core/keep/store.ts'
import type { Entry, Handler } from '#weft/core/keep/outbox.ts'
import type { Timers } from '#weft/core/graph/time.ts'

function fakeWorld(start = 1000) {
  let time = start
  let next = 1
  const jobs = new Map<number, { at: number; fn: () => void }>()
  const timers: Timers = {
    set: (fn, ms) => {
      const id = next++
      jobs.set(id, { at: time + ms, fn })
      return id
    },
    clear: handle => {
      jobs.delete(handle as number)
    },
  }
  return {
    timers,
    now: () => time,
    pending: () => jobs.size,
    async advance(ms: number) {
      const until = time + ms
      for (;;) {
        const due = [...jobs.entries()]
          .filter(([, job]) => job.at <= until)
          .toSorted((a, b) => a[1].at - b[1].at)[0]
        if (due === undefined) break
        const [id, job] = due
        jobs.delete(id)
        time = job.at
        job.fn()
        await settle()
      }
      time = until
      await settle()
    },
  }
}

function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function ids() {
  let n = 0
  return () => `id-${++n}`
}

test('a command is sent with its idempotency key and then leaves the book', async () => {
  const world = fakeWorld()
  const store = memoryStore()
  const seen: Array<{ args: unknown; key: string; attempt: number }> = []
  const book = outbox({
    key: 'out',
    store,
    now: world.now,
    timers: world.timers,
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
  const world = fakeWorld()
  const store = memoryStore()
  const order: string[] = []
  let releaseFirst!: () => void
  const first = new Promise<void>(resolve => {
    releaseFirst = resolve
  })
  const book = outbox({
    key: 'out',
    store,
    now: world.now,
    timers: world.timers,
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
  const world = fakeWorld()
  // A previous run wrote it down and died mid-send.
  await store.write('out', [
    { id: 'kept-key', name: 'pay', args: { amount: 5 }, at: 900, attempts: 1, state: 'sending' },
  ] satisfies Entry[])
  const seen: Array<{ key: string; attempt: number }> = []
  const book = outbox({
    key: 'out',
    store,
    now: world.now,
    timers: world.timers,
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
  const world = fakeWorld()
  const store = memoryStore()
  const attempts: number[] = []
  let calls = 0
  const book = outbox({
    key: 'out',
    store,
    retry: 100,
    now: world.now,
    timers: world.timers,
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
  await world.advance(100)
  assert.deepEqual(attempts, [1, 2])
  await world.advance(150) // the second wait is 200
  assert.deepEqual(attempts, [1, 2])
  await world.advance(100)
  await done
  assert.deepEqual(attempts, [1, 2, 3])
  assert.equal(book.owed.peek(), 0)
  assert.equal(id.length > 0, true)
})

test('after enough failures it gets stuck and waits for a person', async () => {
  const world = fakeWorld()
  const store = memoryStore()
  const stuck: Entry[] = []
  let calls = 0
  const book = outbox({
    key: 'out',
    store,
    retry: 100,
    maxAttempts: 3,
    now: world.now,
    timers: world.timers,
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
  await world.advance(1000)
  await rejected
  assert.equal(calls, 3)
  assert.equal(book.owed.peek(), 0) // owed counts what is still trying
  assert.equal(book.stuck.peek().length, 1)
  assert.equal(stuck.length, 1)
  assert.equal(stuck[0]?.lastError, 'nope')
  await world.advance(10_000)
  assert.equal(calls, 3) // it stopped by itself
})

test('a stuck entry can be tried again or dropped', async () => {
  const world = fakeWorld()
  const store = memoryStore()
  let works = false
  let calls = 0
  const book = outbox({
    key: 'out',
    store,
    retry: 100,
    maxAttempts: 1,
    now: world.now,
    timers: world.timers,
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
  const world = fakeWorld()
  await store.write('out', [
    { id: 'orphan', name: 'gone', args: {}, at: 900, attempts: 0, state: 'waiting' },
  ] satisfies Entry[])
  const book = outbox({ key: 'out', store, now: world.now, timers: world.timers, handlers: {} })
  await book.ready
  await settle()
  const stuck = book.stuck.peek()
  assert.equal(stuck.length, 1)
  assert.match(String(stuck[0]?.lastError), /no handler/)
  assert.equal(book.entries.peek().length, 1) // still on the books
})

test('a paused book holds everything until it is resumed', async () => {
  const world = fakeWorld()
  const store = memoryStore()
  let calls = 0
  const book = outbox({
    key: 'out',
    store,
    paused: true,
    now: world.now,
    timers: world.timers,
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
  const world = fakeWorld()
  const store = memoryStore()
  let release!: () => void
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const book = outbox({
    key: 'out',
    store,
    now: world.now,
    timers: world.timers,
    newId: ids(),
    handlers: {
      slow: (async () => {
        await held
      }) as Handler,
    },
  })
  const label = cell(() => (book.owed.get() === 0 ? 'saved' : `${book.owed.get()} unsent`))
  const seen: string[] = []
  const stop = subscribe(label, value => seen.push(value))
  const { done } = book.send('slow', {})
  assert.equal(label.peek(), '1 unsent')
  release()
  await done
  assert.equal(label.peek(), 'saved')
  assert.deepEqual(seen, ['1 unsent', 'saved'])
  stop()
})

test('an unknown outcome never counts toward poison: the entry is repeated as a matter of course', async () => {
  const world = fakeWorld()
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
    now: world.now,
    timers: world.timers,
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
  await world.advance(10_000)
  assert.ok(seen.length > 4)
  assert.equal(book.stuck.peek().length, 0)

  // Real refusals, and the poison count starts moving: two are enough.
  outcome = 'refusal'
  await world.advance(10_000)
  assert.equal(book.stuck.peek().length, 1)
})

test('discarding leaves a trace through the same door as success', async () => {
  const world = fakeWorld()
  const store = memoryStore()
  const discarded: string[] = []
  const book = outbox({
    key: 'out',
    store,
    now: world.now,
    timers: world.timers,
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
  const world = fakeWorld()
  const refusals: Entry[] = []
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
    timers: world.timers,
    now: world.now,
    onRefused: entry => refusals.push(entry),
  })
  await box.ready

  const { done } = box.send('pay', { n: 1 })
  await world.advance(1)
  await assert.rejects(done)
  assert.deepEqual(calls, ['1']) // one ask, no retries: the no was meaningful
  assert.equal(box.entries.peek().length, 0)
  assert.equal(refusals.length, 1)
  assert.match(refusals[0]?.lastError ?? '', /conflict/)

  // And the no is final: a second refused entry leaves the same way, and the
  // clock holds nothing to retry. (Transient retries are covered above.)
  const { done: second } = box.send('pay', { n: 2 })
  await world.advance(1)
  await assert.rejects(second)
  await world.advance(1000)
  assert.deepEqual(calls, ['1', '2'])
  assert.equal(box.entries.peek().length, 0)
})

test('a retained note stays done until the base absorbs it; a fait accompli is born done', async () => {
  const world = fakeWorld()
  const box = outbox({
    key: 'k',
    store: memoryStore(),
    handlers: { move: (() => Promise.resolve()) as Handler },
    retain: true,
    timers: world.timers,
    now: world.now,
  })
  await box.ready

  const { done } = box.send('move', { id: 'c1' })
  await world.advance(1)
  await done
  const held = box.entries.peek()[0]
  assert.equal(held?.state, 'done') // confirmed, not absorbed: still in the book
  assert.equal(box.owed.peek(), 0) // but owed to nobody
  assert.equal(box.active.peek().length, 1) // and still laying over the base

  const noted = box.note('add', { id: 'c2' })
  assert.equal(box.entries.peek().length, 2)
  assert.equal(box.entries.peek()[1]?.state, 'done')
  assert.ok(noted.id.length > 0)

  box.absorb(world.now() - 1000) // a snapshot older than both: absorbs nothing
  assert.equal(box.entries.peek().length, 2)
  box.absorb(world.now()) // the base caught up
  assert.equal(box.entries.peek().length, 0)
})

test('note() without retain is refused loudly', async () => {
  const world = fakeWorld()
  const box = outbox({
    key: 'k',
    store: memoryStore(),
    handlers: {},
    timers: world.timers,
    now: world.now,
  })
  await box.ready
  assert.throws(() => box.note('add', {}), /needs retain/)
})
