import { test } from 'node:test'
import assert from 'node:assert/strict'
import { input, subscribe } from '#core/graph.ts'
import { source } from '#core/source.ts'
import { keepInput, keepSource, memoryStore } from '#core/keep.ts'
import { valueOf } from '#core/remote.ts'
import type { Dropped } from '#core/keep.ts'
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
    jump(ms: number) {
      time += ms
    },
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

test('a stored cell survives the reload', () => {
  const store = memoryStore()
  const world = fakeWorld()
  const first = input('draft')
  const keptFirst = keepInput(first, { key: 'note', store, now: world.now })
  assert.equal(keptFirst.restored, false)
  first.set('a real note')
  keptFirst.stop()

  const second = input('draft')
  const keptSecond = keepInput(second, { key: 'note', store, now: world.now })
  assert.equal(keptSecond.restored, true)
  assert.equal(second.peek(), 'a real note')
  keptSecond.forget()
  assert.equal(store.read('note'), null)
})

test('a formula is never kept — only what came from outside', () => {
  const store = memoryStore()
  const world = fakeWorld()
  const a = input(1)
  keepInput(a, { key: 'a', store, now: world.now })
  a.set(2)
  assert.deepEqual(
    Object.keys({ a: store.read('a') }).filter(k => store.read(k) !== null),
    ['a'],
  )
  assert.equal(store.read('sum'), null) // nothing else was ever written
})

test('another schema version is dropped, unless a migration rescues it', () => {
  const store = memoryStore()
  const world = fakeWorld()
  const dropped: Dropped[] = []

  const old = input({ title: 'x' })
  const keeping = keepInput(old, { key: 'row', store, version: 1, now: world.now })
  old.set({ title: 'kept' })
  keeping.stop()

  const plain = input({ title: '' })
  const withoutMigration = keepInput(plain, {
    key: 'row',
    store,
    version: 2,
    now: world.now,
    onDropped: why => dropped.push(why),
  })
  assert.equal(withoutMigration.restored, false)
  assert.deepEqual(dropped, ['version'])

  const again = input({ title: 'x' })
  const keepingAgain = keepInput(again, { key: 'row2', store, version: 1, now: world.now })
  again.set({ title: 'kept' })
  keepingAgain.stop()
  const rescued = input({ title: '' })
  const withMigration = keepInput(rescued, {
    key: 'row2',
    store,
    version: 2,
    now: world.now,
    migrate: (stored, from) =>
      from === 1 ? { title: `${(stored as { title: string }).title} (v1)` } : undefined,
  })
  assert.equal(withMigration.restored, true)
  assert.equal(rescued.peek().title, 'kept (v1)')
})

test('what is too old to keep is not put back', () => {
  const store = memoryStore()
  const world = fakeWorld()
  const before = input(0)
  const keeping = keepInput(before, { key: 'n', store, now: world.now })
  before.set(7)
  keeping.stop()

  world.jump(10_000)
  const dropped: Dropped[] = []
  const after = input(0)
  const kept = keepInput(after, {
    key: 'n',
    store,
    maxAge: 5000,
    now: world.now,
    onDropped: why => dropped.push(why),
  })
  assert.equal(kept.restored, false)
  assert.equal(after.peek(), 0)
  assert.deepEqual(dropped, ['age'])
})

test('rubbish on disk is dropped, not thrown', () => {
  const store = memoryStore({ broken: 'not json at all' })
  const world = fakeWorld()
  const dropped: Dropped[] = []
  const target = input('safe')
  const kept = keepInput(target, {
    key: 'broken',
    store,
    now: world.now,
    onDropped: why => dropped.push(why),
  })
  assert.equal(kept.restored, false)
  assert.equal(target.peek(), 'safe')
  assert.deepEqual(dropped, ['unreadable'])
  assert.equal(store.read('broken'), null)
})

test('keeping a source does not ask it for anything', async () => {
  const store = memoryStore()
  const world = fakeWorld()
  let calls = 0
  const feed = source(async () => ++calls, { now: world.now, timers: world.timers })
  keepSource(feed, { key: 'feed', store, now: world.now })
  await settle()
  assert.equal(calls, 0)
  assert.equal(feed.demanded, false)
  assert.equal(world.pending(), 0)
})

test('an answer kept from the last run comes back with its real age', async () => {
  const store = memoryStore()
  const first = fakeWorld(1000)
  let calls = 0
  const feed = source(async () => `answer ${++calls}`, {
    shelfLife: 5000,
    now: first.now,
    timers: first.timers,
  })
  const kept = keepSource(feed, { key: 'feed', store, now: first.now })
  const stop = subscribe(feed.state, () => {})
  await settle()
  assert.equal(calls, 1)
  stop()
  kept.stop()

  // A new run, one second later: the answer is still good, so nobody is asked.
  const soon = fakeWorld(2000)
  let laterCalls = 0
  const revived = source(async () => `answer ${++laterCalls}`, {
    shelfLife: 5000,
    now: soon.now,
    timers: soon.timers,
  })
  const keptAgain = keepSource(revived, { key: 'feed', store, now: soon.now })
  assert.equal(keptAgain.restored, true)
  assert.equal(valueOf(revived.state.peek()), 'answer 1')
  const watching = subscribe(revived.state, () => {})
  await settle()
  assert.equal(laterCalls, 0)
  watching()
})

test('past its shelf life the restored answer is shown and refreshed at once', async () => {
  const store = memoryStore()
  const first = fakeWorld(1000)
  const feed = source(async () => 'old', { shelfLife: 5000, now: first.now, timers: first.timers })
  const kept = keepSource(feed, { key: 'feed', store, now: first.now })
  const stop = subscribe(feed.state, () => {})
  await settle()
  stop()
  kept.stop()

  const late = fakeWorld(60_000)
  let calls = 0
  const revived = source(
    async () => {
      calls++
      return 'new'
    },
    { shelfLife: 5000, now: late.now, timers: late.timers },
  )
  keepSource(revived, { key: 'feed', store, now: late.now })
  assert.equal(valueOf(revived.state.peek()), 'old') // shown while the new one is fetched
  const watching = subscribe(revived.state, () => {})
  assert.equal(valueOf(revived.state.peek()), 'old')
  await settle()
  assert.equal(calls, 1)
  assert.equal(valueOf(revived.state.peek()), 'new')
  watching()
})

test('a refusal never overwrites the good answer on disk', async () => {
  const store = memoryStore()
  const world = fakeWorld()
  let calls = 0
  const feed = source(
    async () => {
      calls++
      if (calls === 1) return 'good'
      throw new Error('down')
    },
    { every: 100, now: world.now, timers: world.timers },
  )
  keepSource(feed, { key: 'feed', store, now: world.now })
  const stop = subscribe(feed.state, () => {})
  await settle()
  await world.advance(100)
  assert.equal(feed.state.peek().kind, 'failed')
  const onDisk = JSON.parse(store.read('feed') ?? '{}') as { value: unknown }
  assert.equal(onDisk.value, 'good')
  stop()
})

test('restore is ignored when the source already holds something', async () => {
  const store = memoryStore({
    feed: JSON.stringify({ v: 1, at: 900, value: 'from disk' }),
  })
  const world = fakeWorld()
  const feed = source(async () => 'from the world', { now: world.now, timers: world.timers })
  const stop = subscribe(feed.state, () => {})
  await settle()
  assert.equal(valueOf(feed.state.peek()), 'from the world')
  const kept = keepSource(feed, { key: 'feed', store, now: world.now })
  assert.equal(kept.restored, true) // it was read
  assert.equal(valueOf(feed.state.peek()), 'from the world') // but not put over a live answer
  stop()
})
