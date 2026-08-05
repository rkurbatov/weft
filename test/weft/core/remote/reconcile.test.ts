import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { derived, port, subscribe } from '#graph/graph/graph.ts'
import { source } from '#async/source.ts'
import { reconcile } from '#async/reconcile.ts'
import { settle, until, world } from '../../../kit/index.ts'

describe('reconciling the world', () => {
  test('the world is brought in line at once and then on every change', async () => {
    const clock = world()
    const identity = port({ user: 'u1', token: 'a' })
    const applied: string[] = []
    const job = reconcile(identity, value => void applied.push(value.token), {
      timers: clock.timers,
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
    const clock = world()
    // Three unrelated things feed the identity a screen must match.
    const login = port('u1')
    const plan = port('free')
    const region = port('eu')
    const headers = derived(() => `${login.get()}/${plan.get()}/${region.get()}`)
    const sent: string[] = []
    const job = reconcile(headers, value => void sent.push(value), { timers: clock.timers })
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
    const clock = world()
    const rows = port({ id: 1, seen: 0 })
    const applied: number[] = []
    const job = reconcile(rows, value => void applied.push(value.id), {
      by: value => value.id,
      timers: clock.timers,
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
    const clock = world()
    let calls = 0
    const feed = source(async () => ++calls, { now: clock.now, timers: clock.timers })
    const job = reconcile(feed.state, () => {}, { timers: clock.timers })
    await settle()
    assert.equal(calls, 0)
    assert.equal(feed.demanded, false)
    job.stop()

    const hot = reconcile(feed.state, () => {}, { demand: true, timers: clock.timers })
    await settle()
    assert.equal(calls, 1)
    assert.equal(feed.demanded, true)
    hot.stop()
    assert.equal(feed.demanded, false)
  })

  test('atOnce off: it starts following from the next change', async () => {
    const clock = world()
    const title = port('first')
    const applied: string[] = []
    const job = reconcile(title, value => void applied.push(value), {
      atOnce: false,
      timers: clock.timers,
    })
    assert.deepEqual(applied, [])
    title.set('second')
    await settle()
    assert.deepEqual(applied, ['second'])
    job.stop()
  })

  test('while one value is being applied, a newer one supersedes the ones between', async () => {
    const clock = world()
    const gates: Array<() => void> = []
    const started: string[] = []
    const wanted = port('a')
    const job = reconcile(
      wanted,
      value =>
        new Promise<void>(resolve => {
          started.push(value)
          gates.push(resolve)
        }),
      { timers: clock.timers },
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
    const clock = world()
    const value = port('x')
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
        timers: clock.timers,
      },
    )
    await settle()
    assert.equal(tries, 1)
    await clock.advance(100)
    assert.equal(tries, 2)
    await clock.advance(150) // the second wait is 200
    assert.equal(tries, 2)
    await clock.advance(100)
    assert.equal(tries, 3)
    assert.equal(errors.length, 3)
    assert.match(String((job.failed.peek() as Error).message), /rejected/)
    await clock.advance(10_000)
    assert.equal(tries, 3) // it gave up on this value
    job.stop()
  })

  test('a new value clears the refusal and starts over', async () => {
    const clock = world()
    const value = port('bad')
    let allow = false
    const job = reconcile(
      value,
      async v => {
        if (!allow && v === 'bad') throw new Error('nope')
      },
      { retry: 100, maxAttempts: 1, timers: clock.timers },
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
    const clock = world()
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const value = port(1)
    const job = reconcile(value, async () => gate, { timers: clock.timers })
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

  test('a newer value calls off the run in flight, rather than letting it finish', async () => {
    const clock = world()
    const title = port('first')
    const started: string[] = []
    const abandoned: string[] = []
    let release = (): void => {}

    const job = reconcile(
      title,
      async (value, signal) => {
        started.push(value)
        await new Promise<void>(resolve => {
          release = resolve
        })
        if (signal.aborted) abandoned.push(value)
      },
      { name: 'title', timers: clock.timers },
    )
    until(job.stop)

    await settle()
    assert.deepEqual(started, ['first'])

    title.set('second')
    await settle()
    assert.deepEqual(started, ['first'], 'the second waits for the first to let go')

    release()
    await settle(3)
    assert.deepEqual(abandoned, ['first'], 'the first learned it was called off')
    assert.deepEqual(started, ['first', 'second'])
    release()
    await settle(2)
  })

  test('stopping calls off the run in flight too', async () => {
    const clock = world()
    const title = port('only')
    let told = false
    let release = (): void => {}

    const job = reconcile(
      title,
      async (_value, signal) => {
        await new Promise<void>(resolve => {
          release = resolve
        })
        told = signal.aborted
      },
      { name: 'title', timers: clock.timers },
    )

    await settle()
    job.stop()
    release()
    await settle(2)
    assert.equal(told, true)
  })
})
