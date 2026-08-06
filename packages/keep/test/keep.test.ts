import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { port, subscribe } from '#graph/graph.ts'
import { keepInput, keepSource } from '#keep/keep.ts'
import { memoryStore } from '#keep/store.ts'
import { source } from '#remote/source.ts'
import type { Dropped } from '#keep/keep.ts'
import { settle, slowStore, world } from '#testkit'

describe('keeping things on disk', () => {
  test('restoring never delays the first show: the initial value stands until the disk answers', async () => {
    const disk = slowStore({ note: { v: 1, at: 900, value: 'from disk' } })
    const target = port('draft')
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
    const clock = world()
    const target = port('draft')
    const kept = keepInput(target, { key: 'note', store: disk.store, now: clock.now })

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
    const clock = world()
    const target = port('a')
    const kept = keepInput(target, { key: 'note', store: disk.store, now: clock.now })
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
    const clock = world()
    const target = port('a')
    const kept = keepInput(target, { key: 'note', store: disk.store, now: clock.now })
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
    const target = port('draft')
    const kept = keepInput(target, { key: 'note', store: disk.store })
    await disk.release(new Error('InvalidStateError'))
    assert.equal(await kept.restored, false)
    assert.equal(kept.saving.peek().ok, false)
    assert.equal(target.peek(), 'draft')
    kept.stop()
  })

  test('a port cell survives the reload', async () => {
    const store = memoryStore()
    const clock = world()
    const first = port('draft')
    const keptFirst = keepInput(first, { key: 'note', store, now: clock.now })
    assert.equal(await keptFirst.restored, false)
    first.set('a real note')
    await settle()
    keptFirst.stop()

    const second = port('draft')
    const keptSecond = keepInput(second, { key: 'note', store, now: clock.now })
    assert.equal(await keptSecond.restored, true)
    assert.equal(second.peek(), 'a real note')
    keptSecond.forget()
    await settle()
    assert.equal(await store.read('note'), undefined)
  })

  test('what is kept needs no text packing: a Date survives as a Date', async () => {
    const store = memoryStore()
    const clock = world()
    const first = port({ title: 'x', at: new Date(7) })
    const kept = keepInput(first, { key: 'row', store, now: clock.now })
    first.set({ title: 'kept', at: new Date(42) })
    await settle()
    kept.stop()

    const second = port({ title: '', at: new Date(0) })
    const keptSecond = keepInput(second, { key: 'row', store, now: clock.now })
    assert.equal(await keptSecond.restored, true)
    assert.ok(second.peek().at instanceof Date)
    assert.equal(second.peek().at.getTime(), 42)
    keptSecond.stop()
  })

  test('another schema version is dropped, unless a migration rescues it', async () => {
    const store = memoryStore()
    const clock = world()
    const dropped: Dropped[] = []

    const old = port({ title: 'x' })
    const keeping = keepInput(old, { key: 'row', store, version: 1, now: clock.now })
    old.set({ title: 'kept' })
    await settle()
    keeping.stop()

    const plain = port({ title: '' })
    const withoutMigration = keepInput(plain, {
      key: 'row',
      store,
      version: 2,
      now: clock.now,
      onDropped: why => dropped.push(why),
    })
    assert.equal(await withoutMigration.restored, false)
    assert.deepEqual(dropped, ['version'])
    withoutMigration.stop()

    const again = port({ title: 'x' })
    const keepingAgain = keepInput(again, { key: 'row2', store, version: 1, now: clock.now })
    again.set({ title: 'kept' })
    await settle()
    keepingAgain.stop()
    const rescued = port({ title: '' })
    const withMigration = keepInput(rescued, {
      key: 'row2',
      store,
      version: 2,
      now: clock.now,
      migrate: (port, from) =>
        from === 1 ? { title: `${(port as { title: string }).title} (v1)` } : undefined,
    })
    assert.equal(await withMigration.restored, true)
    assert.equal(rescued.peek().title, 'kept (v1)')
    withMigration.stop()
  })

  test('what is too old to keep is not put back', async () => {
    const store = memoryStore()
    const clock = world()
    const before = port(0)
    const keeping = keepInput(before, { key: 'n', store, now: clock.now })
    before.set(7)
    await settle()
    keeping.stop()

    clock.jump(10_000)
    const dropped: Dropped[] = []
    const after = port(0)
    const kept = keepInput(after, {
      key: 'n',
      store,
      maxAge: 5000,
      now: clock.now,
      onDropped: why => dropped.push(why),
    })
    assert.equal(await kept.restored, false)
    assert.equal(after.peek(), 0)
    assert.deepEqual(dropped, ['age'])
    kept.stop()
  })

  test('rubbish on disk is dropped, not thrown', async () => {
    const store = memoryStore({ broken: 'not an envelope at all' })
    const clock = world()
    const dropped: Dropped[] = []
    const target = port('safe')
    const kept = keepInput(target, {
      key: 'broken',
      store,
      now: clock.now,
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
    const clock = world()
    let calls = 0
    const feed = source(async () => ++calls, { now: clock.now, timers: clock.timers })
    const kept = keepSource(feed, { key: 'feed', store, now: clock.now })
    await kept.restored
    await settle()
    assert.equal(calls, 0)
    assert.equal(feed.demanded, false)
    assert.equal(clock.pending(), 0)
    kept.stop()
  })

  test('an answer kept from the last run comes back with its real age', async () => {
    const store = memoryStore()
    const first = world(1000)
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
    const soon = world(2000)
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
    const first = world(1000)
    const feed = source(async () => 'old', {
      shelfLife: 5000,
      now: first.now,
      timers: first.timers,
    })
    const kept = keepSource(feed, { key: 'feed', store, now: first.now })
    const stop = subscribe(feed.state, () => {})
    await settle()
    await settle()
    stop()
    kept.stop()

    const late = world(60_000)
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
    const clock = world()
    let calls = 0
    const feed = source(
      async () => {
        calls++
        if (calls === 1) return 'good'
        throw new Error('down')
      },
      { every: 100, now: clock.now, timers: clock.timers },
    )
    const kept = keepSource(feed, { key: 'feed', store, now: clock.now })
    const stop = subscribe(feed.state, () => {})
    await settle()
    await clock.advance(100)
    assert.equal(feed.state.peek().kind, 'failed')
    const onDisk = (await store.read('feed')) as { value: unknown }
    assert.equal(onDisk.value, 'good')
    stop()
    kept.stop()
  })

  test('the network answering before the disk wins: nothing is put over a live answer', async () => {
    const disk = slowStore({ feed: { v: 1, at: 900, value: 'from disk' } })
    const clock = world()
    const feed = source(async () => 'from the world', { now: clock.now, timers: clock.timers })
    const stop = subscribe(feed.state, () => {})
    await settle()
    assert.equal(feed.state.peek().value, 'from the world')

    const kept = keepSource(feed, { key: 'feed', store: disk.store, now: clock.now })
    await disk.release() // the read arrives after the network already has
    assert.equal(await kept.restored, false)
    assert.equal(feed.state.peek().value, 'from the world')
    stop()
    kept.stop()
  })
})
