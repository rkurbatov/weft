import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cell, input, subscribe } from '#weft/core/graph.ts'
import { source } from '#weft/core/source.ts'
import { reconcile } from '#weft/core/reconcile.ts'
import type { Timers } from '#weft/core/time.ts'

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

test('the world is brought in line at once and then on every change', async () => {
  const world = fakeWorld()
  const identity = input({ user: 'u1', token: 'a' })
  const applied: string[] = []
  const job = reconcile(identity, value => void applied.push(value.token), {
    timers: world.timers,
  })
  assert.deepEqual(applied, ['a'])
  identity.set({ user: 'u1', token: 'b' })
  await settle()
  assert.deepEqual(applied, ['a', 'b'])
  job.stop()
  identity.set({ user: 'u1', token: 'c' })
  await settle()
  assert.deepEqual(applied, ['a', 'b'])
})

test('there is no trigger list: whatever moves the value, the world follows', async () => {
  const world = fakeWorld()
  // Three unrelated things feed the identity a screen must match.
  const login = input('u1')
  const plan = input('free')
  const region = input('eu')
  const headers = cell(() => `${login.get()}/${plan.get()}/${region.get()}`)
  const sent: string[] = []
  const job = reconcile(headers, value => void sent.push(value), { timers: world.timers })
  assert.deepEqual(sent, ['u1/free/eu'])
  plan.set('paid')
  await settle()
  region.set('us')
  await settle()
  login.set('u2')
  await settle()
  assert.deepEqual(sent, ['u1/free/eu', 'u1/paid/eu', 'u1/paid/us', 'u2/paid/us'])
  job.stop()
})

test('an equal value is not applied again', async () => {
  const world = fakeWorld()
  const rows = input({ id: 1, seen: 0 })
  const applied: number[] = []
  const job = reconcile(rows, value => void applied.push(value.id), {
    by: value => value.id,
    timers: world.timers,
  })
  rows.set({ id: 1, seen: 1 })
  rows.set({ id: 1, seen: 2 })
  await settle()
  assert.deepEqual(applied, [1])
  rows.set({ id: 2, seen: 2 })
  await settle()
  assert.deepEqual(applied, [1, 2])
  job.stop()
})

test('following is cold: a source is not woken by being reconciled', async () => {
  const world = fakeWorld()
  let calls = 0
  const feed = source(async () => ++calls, { now: world.now, timers: world.timers })
  const job = reconcile(feed.state, () => {}, { timers: world.timers })
  await settle()
  assert.equal(calls, 0)
  assert.equal(feed.demanded, false)
  job.stop()

  const hot = reconcile(feed.state, () => {}, { demand: true, timers: world.timers })
  await settle()
  assert.equal(calls, 1)
  assert.equal(feed.demanded, true)
  hot.stop()
  assert.equal(feed.demanded, false)
})

test('atOnce off: it starts following from the next change', async () => {
  const world = fakeWorld()
  const title = input('first')
  const applied: string[] = []
  const job = reconcile(title, value => void applied.push(value), {
    atOnce: false,
    timers: world.timers,
  })
  assert.deepEqual(applied, [])
  title.set('second')
  await settle()
  assert.deepEqual(applied, ['second'])
  job.stop()
})

test('while one value is being applied, a newer one supersedes the ones between', async () => {
  const world = fakeWorld()
  const gates: Array<() => void> = []
  const started: string[] = []
  const wanted = input('a')
  const job = reconcile(
    wanted,
    value =>
      new Promise<void>(resolve => {
        started.push(value)
        gates.push(resolve)
      }),
    { timers: world.timers },
  )
  assert.deepEqual(started, ['a'])
  wanted.set('b')
  wanted.set('c')
  await settle()
  assert.deepEqual(started, ['a']) // still busy with 'a'
  gates[0]?.()
  await settle()
  assert.deepEqual(started, ['a', 'c']) // 'b' was never the world's state
  gates[1]?.()
  await settle()
  assert.equal(job.settled.peek(), 'c')
  job.stop()
})

test('a refusal is retried with growing waits, then reported', async () => {
  const world = fakeWorld()
  const value = input('x')
  const errors: unknown[] = []
  let tries = 0
  const job = reconcile(
    value,
    async () => {
      tries++
      throw new Error('rejected')
    },
    {
      retry: 100,
      maxAttempts: 3,
      onError: error => errors.push(error),
      timers: world.timers,
    },
  )
  await settle()
  assert.equal(tries, 1)
  await world.advance(100)
  assert.equal(tries, 2)
  await world.advance(150) // the second wait is 200
  assert.equal(tries, 2)
  await world.advance(100)
  assert.equal(tries, 3)
  assert.equal(errors.length, 3)
  assert.match(String((job.failed.peek() as Error).message), /rejected/)
  await world.advance(10_000)
  assert.equal(tries, 3) // it gave up on this value
  job.stop()
})

test('a new value clears the refusal and starts over', async () => {
  const world = fakeWorld()
  const value = input('bad')
  let allow = false
  const job = reconcile(
    value,
    async v => {
      if (!allow && v === 'bad') throw new Error('nope')
    },
    { retry: 100, maxAttempts: 1, timers: world.timers },
  )
  await settle()
  assert.notEqual(job.failed.peek(), undefined)
  allow = true
  value.set('good')
  await settle()
  assert.equal(job.failed.peek(), undefined)
  assert.equal(job.settled.peek(), 'good')
  job.stop()
})

test('working and settled are cells: a screen can watch the reconciliation itself', async () => {
  const world = fakeWorld()
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const value = input(1)
  const job = reconcile(value, async () => gate, { timers: world.timers })
  const seen: boolean[] = []
  const stop = subscribe(job.working, v => seen.push(v))
  assert.equal(job.working.peek(), true)
  release()
  await settle()
  assert.equal(job.working.peek(), false)
  assert.equal(job.settled.peek(), 1)
  assert.deepEqual(seen, [false])
  stop()
  job.stop()
})
