// The one promise the outbox exists to keep: written down before it is sent.
//
// Every case here is a death at a named point. The word "durable" is cheap to
// write in a README and only means something if the moment between the effect
// on the world and the record of it can be shown to be empty — so the disk is
// driven by hand and the send is watched against it.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { book } from '#outbox/book.ts'
import { outbox } from '#outbox'
import type { Note } from '#outbox'
import { memoryStore } from '#store'
import type { Store } from '#store'
import { settle, slowStore, world } from '#testkit'

const idsOn = async (disk: Store, key = 'outbox'): Promise<string[]> =>
  (((await disk.read(key)) ?? []) as Note[]).map(one => one.id)

/** The bytes a hand-driven disk is holding, read without queueing a gate. */
const idsIn = (cells: Map<string, unknown>, key = 'outbox'): string[] =>
  ((cells.get(key) ?? []) as Note[]).map(one => one.id)

describe('written down before it is sent', () => {
  test('the handler does not run until the disk has confirmed the note', async () => {
    const disk = slowStore()
    const ran: string[] = []
    let onDiskWhenSent: string[] | undefined
    const box = outbox({
      key: 'outbox',
      store: disk.store,
      newId: () => 'one',
      handlers: {
        buy: async () => {
          ran.push('buy')
          onDiskWhenSent = ((disk.cells.get('outbox') ?? []) as Note[]).map(one => one.id)
        },
      },
    })
    await disk.release() // the lift reads
    await box.ready

    box.send('buy', { seat: 12 })
    await settle()
    // The write is out there; nothing may be sent on the strength of that.
    assert.deepEqual(ran, [], 'sent while the write was still travelling')
    assert.deepEqual(disk.asked(), ['write'])

    await disk.release() // the write lands
    await settle()
    assert.deepEqual(ran, ['buy'])
    assert.deepEqual(onDiskWhenSent, ['one'], 'the note was not on the disk when it was sent')
  })

  test('the second note waits for its own write, not for the first one', async () => {
    // The trap the first fix leaves behind: gating only `send` lets the entry
    // behind a finished one go out on the pump that follows it.
    const disk = slowStore()
    const ran: string[] = []
    const box = outbox({
      key: 'outbox',
      store: disk.store,
      newId: () => `n${ran.length}`,
      handlers: { buy: async (args: never) => void ran.push(String((args as { n: number }).n)) },
    })
    await disk.release()
    await box.ready

    box.send('buy', { n: 1 })
    await disk.release() // the first write lands
    await settle()
    assert.deepEqual(ran, ['1'])

    box.send('buy', { n: 2 })
    await settle()
    assert.deepEqual(ran, ['1'], 'the second went out before its write landed')
    await disk.releaseAll()
    assert.deepEqual(ran, ['1', '2'])
  })

  test('a refused write sends nothing, keeps the intent, and goes out when the disk returns', async () => {
    const clock = world()
    const disk = slowStore()
    const ran: string[] = []
    const box = outbox({
      key: 'outbox',
      store: disk.store,
      retry: 10,
      timers: clock.timers,
      newId: () => 'one',
      handlers: { buy: async () => void ran.push('buy') },
    })
    await disk.release()
    await box.ready

    box.send('buy', { seat: 12 })
    await disk.release(new Error('QuotaExceededError: full')) // the write is refused
    await settle()
    assert.deepEqual(ran, [], 'sent over a disk that refused the write')
    assert.equal(box.saving.peek().ok, false)
    // The intent is not lost: it is owed, and it says so.
    assert.equal(box.owed.peek(), 1)

    await clock.advance(20) // the disk clock comes round
    await disk.releaseAll()
    assert.deepEqual(ran, ['buy'])
    assert.equal(box.saving.peek().ok, true)
  })

  test('a note that landed but was never sent goes out once on the next run', async () => {
    const disk = memoryStore()
    const ran: Array<{ key: string; attempt: number }> = []
    const dead = outbox({
      key: 'outbox',
      store: disk,
      paused: true, // written down, never sent: the tab died here
      newId: () => 'one',
      handlers: { buy: async () => {} },
    })
    await dead.ready
    dead.send('buy', { seat: 12 })
    await settle()
    assert.deepEqual(await idsOn(disk), ['one'])

    const next = outbox({
      key: 'outbox',
      store: disk,
      handlers: { buy: async (_args: never, handling) => void ran.push({ ...handling }) },
    })
    await next.ready
    await settle()
    assert.equal(ran.length, 1, 'a lifted note must go out exactly once')
    assert.equal(ran[0]?.key, 'one', 'the idempotency key survives the death')
    assert.deepEqual(await idsOn(disk), [])
  })
})

describe('a book that could not be read', () => {
  test('is not an empty book: nothing is lifted, sent, or written over it', async () => {
    const disk = slowStore()
    const ran: string[] = []
    const box = outbox({
      key: 'outbox',
      store: disk.store,
      retry: 1,
      newId: () => 'one',
      handlers: { buy: async () => void ran.push('buy') },
    })
    // Whatever a previous run left is under this key; the disk will not say.
    disk.cells.set('outbox', [
      { id: 'old', name: 'buy', args: {}, at: 1, attempts: 0, state: 'waiting' },
    ])
    await disk.release(new Error('UnknownError: the disk did not answer'))
    await box.ready

    box.send('buy', { seat: 12 })
    await settle()
    assert.deepEqual(ran, [], 'sent over a book nobody could read')
    assert.equal(box.saving.peek().ok, false)
    assert.deepEqual(idsIn(disk.cells), ['old'], 'the unread book was buried')
  })

  test('reopens and lifts what was there, oldest first', async () => {
    const clock = world()
    const disk = slowStore()
    const ran: string[] = []
    const old: Note = { id: 'old', name: 'buy', args: {}, at: 1, attempts: 0, state: 'waiting' }
    disk.cells.set('outbox', [old])
    const box = outbox({
      key: 'outbox',
      store: disk.store,
      retry: 10,
      timers: clock.timers,
      newId: () => 'new',
      handlers: { buy: async (_a: never, handling) => void ran.push(handling.key) },
    })
    await disk.release(new Error('UnknownError: the disk did not answer'))
    await box.ready
    box.send('buy', {})
    await settle()
    assert.deepEqual(ran, [])

    await clock.advance(20) // the disk clock comes round
    await disk.releaseAll()
    // What was written down earlier goes out earlier, across a reload and a
    // failed read alike.
    assert.deepEqual(ran, ['old', 'new'])
  })
})

describe('the barrier the book hands back', () => {
  test('settles on the write that covers it, and fails when the disk refuses', async () => {
    const disk = slowStore()
    const pages = book('outbox', disk.store, () => {})
    await disk.release()
    await pages.ready

    const first = pages.write([
      { id: 'a', name: 'x', args: {}, at: 1, attempts: 0, state: 'waiting' },
    ])
    // A second state while the first is still travelling: one write covers both.
    const second = pages.write([
      { id: 'a', name: 'x', args: {}, at: 1, attempts: 0, state: 'waiting' },
      { id: 'b', name: 'x', args: {}, at: 2, attempts: 0, state: 'waiting' },
    ])
    await disk.releaseAll()
    await first
    await second
    assert.equal(pages.confirmed('b'), true)

    const refused = pages.write([])
    await disk.release(new Error('QuotaExceededError: full'))
    await assert.rejects(refused)
    // The state stays owed rather than vanishing with the failed attempt.
    const flushed = pages.flush()
    await disk.releaseAll()
    await flushed
    assert.deepEqual(idsIn(disk.cells), [])
  })
})
