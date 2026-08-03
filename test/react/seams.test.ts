// The React seams' working part, tested without a renderer: arrivalOf carries
// the demand and the promise; the hooks over it are thin adapters checked by
// the compiler and exercised by the demos.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { source } from '#core/source.ts'
import { arrivalOf } from '#weft/react'
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

test('asking for the arrival is what starts the load; the demand leaves with it', async () => {
  const world = fakeWorld()
  let asked = 0
  const feed = source(
    () => {
      asked++
      return Promise.resolve('answer')
    },
    { name: 'feed', timers: world.timers, now: world.now },
  )
  assert.equal(feed.demanded, false)

  const first = arrivalOf(feed)
  const second = arrivalOf(feed)
  assert.equal(first, second) // one promise per unsettled source
  assert.equal(feed.demanded, true) // the asking itself is the demand

  await world.advance(1)
  await first
  assert.equal(asked, 1)
  assert.equal(feed.demanded, false) // nothing lingers once it landed

  await arrivalOf(feed) // already held: resolves at once, asks nothing
  assert.equal(asked, 1)
})

test('the first refusal settles the arrival', async () => {
  const world = fakeWorld()
  const feed = source(() => Promise.reject(new Error('down')), {
    name: 'sour',
    timers: world.timers,
    now: world.now,
  })
  const landing = arrivalOf(feed)
  await world.advance(1)
  await landing // resolves — the throw itself is the hook's business, not the promise's
  assert.equal(feed.state.peek().kind, 'failed')
  assert.equal(feed.demanded, false)
})
