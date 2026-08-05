// The book and the schedule, each on its own.
//
// The point of splitting them out of the outbox is exactly this: a book can be
// tested with a disk and no clock, a schedule with a clock and no disk. What is
// left in the outbox — deciding what a refusal means — is tested there.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { book } from '#offline/book.ts'
import type { Entry } from '#offline/book.ts'
import { schedule } from '#offline/schedule.ts'
import { memoryStore } from '#offline/store.ts'
import { settle, slowStore, world } from '../../../kit/index.ts'

const entry = (id: string, name = 'move'): Entry => ({
  id,
  name,
  args: { at: id },
  at: 1000,
  attempts: 0,
  state: 'waiting',
})

describe('the book', () => {
  test('lifts what a previous run left, and puts newborn entries after it', async () => {
    const disk = memoryStore()
    await disk.write('outbox', [entry('old')])

    const pages = book('outbox', disk, () => {})
    // Written down before the lift: it must not bury the old book, and must
    // not jump the queue either — what was written earlier goes out earlier.
    pages.write([entry('new')])
    await pages.ready

    assert.deepEqual(
      pages.entries.peek().map(e => e.id),
      ['old', 'new'],
    )
    assert.deepEqual(
      ((await disk.read('outbox')) as Entry[]).map(e => e.id),
      ['old', 'new'],
    )
  })

  test('a disk that cannot be read leaves an empty book and says so', async () => {
    const disk = {
      ...memoryStore(),
      read: () => Promise.reject(new Error('quota')),
    }
    const pages = book('outbox', disk, () => {})
    await pages.ready
    assert.deepEqual(pages.entries.peek(), [])
    assert.equal(pages.saving.peek().ok, false)
  })

  test('nonsense left on the disk is not lifted', async () => {
    const disk = memoryStore()
    await disk.write('outbox', [{ nothing: true }, entry('good'), 'rubbish'])
    const pages = book('outbox', disk, () => {})
    await pages.ready
    assert.deepEqual(
      pages.entries.peek().map(e => e.id),
      ['good'],
    )
  })

  test('writes coalesce while one is in flight: the disk ends on the latest', async () => {
    const disk = slowStore()
    const pages = book('outbox', disk.store, () => {})
    await disk.release() // the read
    await pages.ready
    await disk.releaseAll() // the write that follows the lift, if any

    pages.write([entry('a')])
    pages.write([entry('a'), entry('b')])
    pages.write([entry('b')])
    // Three writes, at most two trips: the middle one is overtaken.
    assert.ok(disk.asked().length <= 2, `asked: ${disk.asked().join(', ')}`)
    await disk.releaseAll()
    assert.deepEqual(
      (disk.cells.get('outbox') as Entry[]).map(e => e.id),
      ['b'],
    )
  })

  test('a refused write is a state, not a silence — and the next one mends it', async () => {
    const disk = slowStore()
    const pages = book('outbox', disk.store, () => {})
    await disk.release()
    await pages.ready

    pages.write([entry('a')])
    await disk.release(new Error('disk full'))
    assert.equal(pages.saving.peek().ok, false)

    pages.write([entry('a'), entry('b')])
    await disk.releaseAll()
    assert.equal(pages.saving.peek().ok, true)
  })

  test('replace and remove touch one entry and leave the rest alone', async () => {
    const disk = memoryStore()
    const pages = book('outbox', disk, () => {})
    await pages.ready
    pages.write([entry('a'), entry('b'), entry('c')])

    pages.replace('b', e => ({ ...e, state: 'stuck', lastError: 'nope' }))
    assert.deepEqual(
      pages.entries.peek().map(e => e.state),
      ['waiting', 'stuck', 'waiting'],
    )

    pages.remove('a')
    await settle()
    assert.deepEqual(
      ((await disk.read('outbox')) as Entry[]).map(e => e.id),
      ['b', 'c'],
    )
  })
})

describe('the schedule', () => {
  test('waits longer after every refusal, up to a cap', () => {
    const clock = schedule({ retry: 100, cap: 800 })
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6].map(attempt => clock.backoff(attempt)),
      [100, 200, 400, 800, 800, 800],
    )
  })

  test('one timer at a time: a new wait replaces the one before it', async () => {
    const time = world()
    const clock = schedule({ retry: 100, timers: time.timers })
    const fired: string[] = []

    clock.after(100, () => fired.push('first'))
    clock.after(50, () => fired.push('second'))
    assert.equal(time.pending(), 1, 'the first wait was called off')

    await time.advance(60)
    assert.deepEqual(fired, ['second'])
    assert.equal(clock.waiting(), false)
  })

  test('being held calls off what was waiting, and nothing waits until released', async () => {
    const time = world()
    const clock = schedule({ retry: 100, timers: time.timers })
    let fired = 0

    clock.after(100, () => fired++)
    clock.hold()
    assert.equal(time.pending(), 0, 'nothing stays on the clock')

    await time.advance(500)
    assert.equal(fired, 0)
    assert.equal(clock.held(), true)

    clock.release()
    clock.after(100, () => fired++)
    await time.advance(100)
    assert.equal(fired, 1)
  })

  test('starting held is a passport, not a call', () => {
    const clock = schedule({ paused: true })
    assert.equal(clock.held(), true)
    clock.release()
    assert.equal(clock.held(), false)
  })
})
