import { test } from 'node:test'
import assert from 'node:assert/strict'
import { input, subscribe } from '#weft/core/graph/graph.ts'
import { source } from '#weft/core/remote/source.ts'
import { keepInput, keepSource } from '#weft/core/keep/keep.ts'
import { memoryStore } from '#weft/core/keep/store.ts'
import type { Dropped } from '#weft/core/keep/keep.ts'
import type { Store } from '#weft/core/keep/store.ts'
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

/**
 * A disk that answers only when told to. Every operation queues a gate;
 * `release` opens the next one — or slams it with an error instead.
 */
function slowStore(seed: Record<string, unknown> = {}) {
  const cells = new Map<string, unknown>(Object.entries(seed))
  const gates: Array<{ kind: string; open: () => void; slam: (error: Error) => void }> = []
  const wait = <T>(kind: string, work: () => T): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      gates.push({ kind, open: () => resolve(work()), slam: reject })
    })
  const store: Store = {
    read: key => wait('read', () => (cells.has(key) ? structuredClone(cells.get(key)) : undefined)),
    write: (key, value) =>
      wait('write', () => {
        cells.set(key, structuredClone(value))
      }),
    remove: key =>
      wait('remove', () => {
        cells.delete(key)
      }),
    keys: prefix =>
      wait('keys', () =>
        [...cells.keys()].filter(key => prefix === undefined || key.startsWith(prefix)),
      ),
  }
  return {
    cells,
    store,
    asked: () => gates.map(gate => gate.kind),
    async release(error?: Error) {
      const gate = gates.shift()
      assert.notEqual(gate, undefined, 'nothing waiting on the disk')
      if (error === undefined) gate!.open()
      else gate!.slam(error)
      await settle()
    },
  }
}

test('restoring never delays the first show: the initial value stands until the disk answers', async () => {
  const disk = slowStore({ note: { v: 1, at: 900, value: 'from disk' } })
  const target = input('draft')
  const kept = keepInput(target, { key: 'note', store: disk.store })

  // The screen is already showing; the disk is still thinking.
  assert.equal(target.peek(), 'draft')
  await disk.release() // the read comes back
  assert.equal(target.peek(), 'from disk')
  assert.equal(await kept.restored, true)
  kept.stop()
})

test('an edit made while the disk was thinking wins over what the disk holds', async () => {
  const disk = slowStore({ note: { v: 1, at: 900, value: 'from disk' } })
  const world = fakeWorld()
  const target = input('draft')
  const kept = keepInput(target, { key: 'note', store: disk.store, now: world.now })

  target.set('typed before the disk answered')
  await disk.release() // the read arrives too late
  assert.equal(target.peek(), 'typed before the disk answered')
  assert.equal(await kept.restored, false)

  await disk.release() // the write of the edit lands
  assert.deepEqual(disk.cells.get('note'), {
    v: 1,
    at: 1000,
    value: 'typed before the disk answered',
  })
  kept.stop()
})

test('quick edits on a slow disk are never lost: the disk ends on the latest', async () => {
  const disk = slowStore()
  const world = fakeWorld()
  const target = input('a')
  const kept = keepInput(target, { key: 'note', store: disk.store, now: world.now })
  await disk.release() // the read: nothing there

  target.set('b') // goes into flight
  target.set('c') // queued while 'b' flies
  target.set('d') // replaces 'c' in the queue
  await disk.release() // 'b' lands
  await disk.release() // the queued latest lands
  assert.deepEqual(disk.asked(), []) // two writes, not three
  assert.equal((disk.cells.get('note') as { value: unknown }).value, 'd')
  kept.stop()
})

test('a refusal to write is declared, and the next change recovers by itself', async () => {
  const disk = slowStore()
  const world = fakeWorld()
  const target = input('a')
  const kept = keepInput(target, { key: 'note', store: disk.store, now: world.now })
  await disk.release() // the read
  assert.equal(kept.saving.peek().ok, true)

  target.set('b')
  await disk.release(new Error('QuotaExceededError'))
  const state = kept.saving.peek()
  assert.equal(state.ok, false)
  assert.match((state as { reason: string }).reason, /QuotaExceededError/)

  // The quota was freed; the next edit simply tries again.
  target.set('c')
  await disk.release()
  assert.equal(kept.saving.peek().ok, true)
  assert.equal((disk.cells.get('note') as { value: unknown }).value, 'c')
  kept.stop()
})

test('a disk that cannot even be read is the same declared state', async () => {
  const disk = slowStore()
  const target = input('draft')
  const kept = keepInput(target, { key: 'note', store: disk.store })
  await disk.release(new Error('InvalidStateError'))
  assert.equal(await kept.restored, false)
  assert.equal(kept.saving.peek().ok, false)
  assert.equal(target.peek(), 'draft')
  kept.stop()
})

test('a stored cell survives the reload', async () => {
  const store = memoryStore()
  const world = fakeWorld()
  const first = input('draft')
  const keptFirst = keepInput(first, { key: 'note', store, now: world.now })
  assert.equal(await keptFirst.restored, false)
  first.set('a real note')
  await settle()
  keptFirst.stop()

  const second = input('draft')
  const keptSecond = keepInput(second, { key: 'note', store, now: world.now })
  assert.equal(await keptSecond.restored, true)
  assert.equal(second.peek(), 'a real note')
  keptSecond.forget()
  await settle()
  assert.equal(await store.read('note'), undefined)
})

test('what is kept needs no text packing: a Date survives as a Date', async () => {
  const store = memoryStore()
  const world = fakeWorld()
  const first = input({ title: 'x', at: new Date(7) })
  const kept = keepInput(first, { key: 'row', store, now: world.now })
  first.set({ title: 'kept', at: new Date(42) })
  await settle()
  kept.stop()

  const second = input({ title: '', at: new Date(0) })
  const keptSecond = keepInput(second, { key: 'row', store, now: world.now })
  assert.equal(await keptSecond.restored, true)
  assert.ok(second.peek().at instanceof Date)
  assert.equal(second.peek().at.getTime(), 42)
  keptSecond.stop()
})

test('another schema version is dropped, unless a migration rescues it', async () => {
  const store = memoryStore()
  const world = fakeWorld()
  const dropped: Dropped[] = []

  const old = input({ title: 'x' })
  const keeping = keepInput(old, { key: 'row', store, version: 1, now: world.now })
  old.set({ title: 'kept' })
  await settle()
  keeping.stop()

  const plain = input({ title: '' })
  const withoutMigration = keepInput(plain, {
    key: 'row',
    store,
    version: 2,
    now: world.now,
    onDropped: why => dropped.push(why),
  })
  assert.equal(await withoutMigration.restored, false)
  assert.deepEqual(dropped, ['version'])
  withoutMigration.stop()

  const again = input({ title: 'x' })
  const keepingAgain = keepInput(again, { key: 'row2', store, version: 1, now: world.now })
  again.set({ title: 'kept' })
  await settle()
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
  assert.equal(await withMigration.restored, true)
  assert.equal(rescued.peek().title, 'kept (v1)')
  withMigration.stop()
})

test('what is too old to keep is not put back', async () => {
  const store = memoryStore()
  const world = fakeWorld()
  const before = input(0)
  const keeping = keepInput(before, { key: 'n', store, now: world.now })
  before.set(7)
  await settle()
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
  assert.equal(await kept.restored, false)
  assert.equal(after.peek(), 0)
  assert.deepEqual(dropped, ['age'])
  kept.stop()
})

test('rubbish on disk is dropped, not thrown', async () => {
  const store = memoryStore({ broken: 'not an envelope at all' })
  const world = fakeWorld()
  const dropped: Dropped[] = []
  const target = input('safe')
  const kept = keepInput(target, {
    key: 'broken',
    store,
    now: world.now,
    onDropped: why => dropped.push(why),
  })
  assert.equal(await kept.restored, false)
  assert.equal(target.peek(), 'safe')
  assert.deepEqual(dropped, ['unreadable'])
  await settle()
  assert.equal(await store.read('broken'), undefined)
  kept.stop()
})

test('keeping a source does not ask it for anything', async () => {
  const store = memoryStore()
  const world = fakeWorld()
  let calls = 0
  const feed = source(async () => ++calls, { now: world.now, timers: world.timers })
  const kept = keepSource(feed, { key: 'feed', store, now: world.now })
  await kept.restored
  await settle()
  assert.equal(calls, 0)
  assert.equal(feed.demanded, false)
  assert.equal(world.pending(), 0)
  kept.stop()
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
  await settle()
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
  assert.equal(await keptAgain.restored, true)
  assert.equal(revived.state.peek().value, 'answer 1')
  const watching = subscribe(revived.state, () => {})
  await settle()
  assert.equal(laterCalls, 0)
  watching()
  keptAgain.stop()
})

test('past its shelf life the restored answer is shown and refreshed at once', async () => {
  const store = memoryStore()
  const first = fakeWorld(1000)
  const feed = source(async () => 'old', { shelfLife: 5000, now: first.now, timers: first.timers })
  const kept = keepSource(feed, { key: 'feed', store, now: first.now })
  const stop = subscribe(feed.state, () => {})
  await settle()
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
  const keptLate = keepSource(revived, { key: 'feed', store, now: late.now })
  assert.equal(await keptLate.restored, true)
  assert.equal(revived.state.peek().value, 'old') // shown while the new one is fetched
  const watching = subscribe(revived.state, () => {})
  assert.equal(revived.state.peek().value, 'old')
  await settle()
  assert.equal(calls, 1)
  assert.equal(revived.state.peek().value, 'new')
  watching()
  keptLate.stop()
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
  const kept = keepSource(feed, { key: 'feed', store, now: world.now })
  const stop = subscribe(feed.state, () => {})
  await settle()
  await world.advance(100)
  assert.equal(feed.state.peek().kind, 'failed')
  const onDisk = (await store.read('feed')) as { value: unknown }
  assert.equal(onDisk.value, 'good')
  stop()
  kept.stop()
})

test('the network answering before the disk wins: nothing is put over a live answer', async () => {
  const disk = slowStore({ feed: { v: 1, at: 900, value: 'from disk' } })
  const world = fakeWorld()
  const feed = source(async () => 'from the world', { now: world.now, timers: world.timers })
  const stop = subscribe(feed.state, () => {})
  await settle()
  assert.equal(feed.state.peek().value, 'from the world')

  const kept = keepSource(feed, { key: 'feed', store: disk.store, now: world.now })
  await disk.release() // the read arrives after the network already has
  assert.equal(await kept.restored, false)
  assert.equal(feed.state.peek().value, 'from the world')
  stop()
  kept.stop()
})
