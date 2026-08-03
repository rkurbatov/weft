import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cell, subscribe } from '#weft/core/graph.ts'
import { source, fresh } from '#weft/core/source.ts'
import type { Timers } from '#weft/core/time.ts'

function fakeWorld() {
  let time = 1000
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

function counting(world: ReturnType<typeof fakeWorld>, options: Record<string, unknown> = {}) {
  let calls = 0
  const feed = source(async () => ++calls, { now: world.now, timers: world.timers, ...options })
  return { feed, calls: () => calls }
}

test('without a requirement or a pace, a source loads once per demand', async () => {
  const world = fakeWorld()
  const { feed, calls } = counting(world)
  const stop = subscribe(feed.state, () => {})
  await settle()
  assert.equal(calls(), 1)
  assert.equal(feed.pace, undefined)
  await world.advance(10_000)
  assert.equal(calls(), 1)
  stop()
})

test('a requirement sets the pace, withdrawing it lets the pace go', async () => {
  const world = fakeWorld()
  const { feed, calls } = counting(world)
  const stop = subscribe(feed.state, () => {})
  await settle()
  assert.equal(calls(), 1)
  const release = feed.require(100)
  assert.equal(feed.pace, 100)
  await world.advance(250)
  assert.equal(calls(), 3)
  release()
  assert.equal(feed.pace, undefined)
  await world.advance(1000)
  assert.equal(calls(), 3)
  stop()
})

test('the strictest live requirement wins; when it goes, the pace relaxes', async () => {
  const world = fakeWorld()
  const { feed, calls } = counting(world)
  const stop = subscribe(feed.state, () => {})
  await settle()
  const loose = feed.require(400)
  const tight = feed.require(100)
  assert.equal(feed.pace, 100)
  await world.advance(300)
  const fast = calls()
  assert.ok(fast >= 3, `expected the tight pace, got ${fast} calls`)
  tight()
  assert.equal(feed.pace, 400)
  await world.advance(300)
  assert.equal(calls(), fast) // 400 has not come round yet
  loose()
  stop()
})

test('a requirement stricter than the declared pace tightens it', async () => {
  const world = fakeWorld()
  const { feed } = counting(world, { every: 1000 })
  const stop = subscribe(feed.state, () => {})
  await settle()
  assert.equal(feed.pace, 1000)
  const release = feed.require(100)
  assert.equal(feed.pace, 100)
  release()
  assert.equal(feed.pace, 1000)
  stop()
})

test('stating a requirement on something already too old asks at once', async () => {
  const world = fakeWorld()
  const { feed, calls } = counting(world)
  const stop = subscribe(feed.state, () => {})
  await settle()
  assert.equal(calls(), 1)
  await world.advance(500)
  assert.equal(calls(), 1) // nobody asked for anything fresher
  const release = feed.require(100) // held value is 500ms old
  await settle()
  assert.equal(calls(), 2)
  release()
  stop()
})

test('the floor holds, and asking below it is reported', async () => {
  const world = fakeWorld()
  const unmet: Array<{ wanted: number; floor: number }> = []
  const { feed } = counting(world, {
    floor: 1000,
    onUnmet: (u: { wanted: number; floor: number }) =>
      unmet.push({ wanted: u.wanted, floor: u.floor }),
  })
  const stop = subscribe(feed.state, () => {})
  await settle()
  const release = feed.require(50)
  assert.equal(feed.pace, 1000)
  assert.deepEqual(unmet, [{ wanted: 50, floor: 1000 }])
  release()
  stop()
})

test('fresh(): the requirement arrives and leaves with the watcher', async () => {
  const world = fakeWorld()
  const { feed, calls } = counting(world)
  const view = fresh(feed, 100)
  assert.equal(calls(), 0)
  const stop = subscribe(view, () => {})
  await settle()
  assert.equal(calls(), 1)
  assert.equal(feed.pace, 100)
  await world.advance(250)
  assert.equal(calls(), 3)
  stop()
  assert.equal(feed.pace, undefined)
  assert.equal(feed.demanded, false)
  await world.advance(1000)
  assert.equal(calls(), 3)
  assert.equal(world.pending(), 0)
})

test('fresh(): two screens, two requirements, the strict one rules while it lives', async () => {
  const world = fakeWorld()
  const { feed } = counting(world, { every: 1000 })
  const slow = fresh(feed, 500)
  const quick = fresh(feed, 100)
  const stopSlow = subscribe(slow, () => {})
  const stopQuick = subscribe(quick, () => {})
  await settle()
  assert.equal(feed.pace, 100)
  stopQuick()
  assert.equal(feed.pace, 500)
  stopSlow()
  // The declared pace stays; with nobody watching, nothing is scheduled by it.
  assert.equal(feed.pace, 1000)
  assert.equal(feed.demanded, false)
  assert.equal(world.pending(), 0)
})

test('fresh(): the value reads through, formulas depend on it as usual', async () => {
  const world = fakeWorld()
  const { feed } = counting(world, { every: 100 })
  const view = fresh(feed, 100)
  const doubled = cell(() => (view.get().value ?? 0) * 2)
  const stop = subscribe(doubled, () => {})
  await settle()
  assert.equal(doubled.peek(), 2)
  await world.advance(100)
  assert.equal(doubled.peek(), 4)
  stop()
})
