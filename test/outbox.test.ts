import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cell, subscribe } from '#core/graph.ts'
import { outbox } from '#core/outbox.ts'
import { memoryStore } from '#core/keep.ts'
import type { Entry, Handler } from '#core/outbox.ts'
import type { Timers } from '#core/source.ts'

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
  assert.equal(store.read('out'), '[]')
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
  store.write(
    'out',
    JSON.stringify([
      { id: 'kept-key', name: 'pay', args: { amount: 5 }, at: 900, attempts: 1, state: 'sending' },
    ] satisfies Entry[]),
  )
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
  assert.equal(book.owed.peek(), 1)
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
  await assert.rejects(dropped.done, /forgotten/)
  assert.equal(book.entries.peek().length, 0)
})

test('an entry whose handler is unknown gets stuck instead of vanishing', async () => {
  const store = memoryStore()
  const world = fakeWorld()
  store.write(
    'out',
    JSON.stringify([
      { id: 'orphan', name: 'gone', args: {}, at: 900, attempts: 0, state: 'waiting' },
    ] satisfies Entry[]),
  )
  const book = outbox({ key: 'out', store, now: world.now, timers: world.timers, handlers: {} })
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
