import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cell, input, subscribe } from '#core/graph.ts'
import { region } from '#core/region.ts'
import { source } from '#core/source.ts'
import { outbox } from '#core/outbox.ts'
import { memoryStore } from '#core/store.ts'
import type { Timers } from '#core/time.ts'

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
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
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

test('a region lets go of its watchers and cells in one move', () => {
  const outside = input(1)
  let woke = 0
  const box = region('mod', () => {
    const doubled = cell(() => outside.get() * 2, { name: 'doubled' })
    subscribe(doubled, () => woke++)
    return doubled
  })
  outside.set(2)
  assert.equal(woke, 1)
  assert.equal(box.value.name, 'mod.doubled') // the region names its own

  box.dispose()
  outside.set(3)
  assert.equal(woke, 1) // nobody is listening anymore
})

test('a region stops the clock of a source born inside it', async () => {
  const world = fakeWorld()
  let asked = 0
  const box = region('mod', () => {
    const feed = source(
      () => {
        asked++
        return Promise.resolve(asked)
      },
      { name: 'feed', every: 50, timers: world.timers, now: world.now },
    )
    subscribe(feed.state, () => {})
    return feed
  })
  await world.advance(1) // let the first answer land and set the clock
  assert.equal(asked, 1)
  await world.advance(120)
  assert.ok(asked >= 2) // it was alive and asking

  const was = asked
  box.dispose()
  await world.advance(500)
  assert.equal(asked, was) // the clock is stopped, nothing asks again
  assert.equal(world.pending(), 0)
})

test('a region holds the book of an outbox born inside it', async () => {
  const world = fakeWorld()
  let sent = 0
  const box = region('mod', () =>
    outbox({
      key: 'k',
      store: memoryStore(),
      handlers: {
        // Always transient: the entry keeps returning to the clock.
        nudge: () => {
          sent++
          return Promise.reject(new Error('flaky'))
        },
      },
      retry: 20,
      timers: world.timers,
      now: world.now,
    }),
  )
  await box.value.ready
  box.value.send('nudge', {})
  await world.advance(1)
  assert.ok(sent >= 1)

  const was = sent
  box.dispose()
  await world.advance(1000)
  assert.equal(sent, was) // held: nothing more goes out
  assert.equal(world.pending(), 0) // and nothing stays on the clock
  assert.equal(box.value.entries.peek().length, 1) // the book keeps what is owed
})

test('regions nest and so do their names', () => {
  const box = region('app', () => region('board', () => cell(() => 1, { name: 'size' })))
  assert.equal(box.value.value.name, 'app.board.size')
  box.dispose()
})
