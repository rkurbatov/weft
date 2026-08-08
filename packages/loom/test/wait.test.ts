// Waiting on state, and standing handlers that follow it.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { port } from '#weft'
import { Timeout, when, whenever } from '#loom'
import { settle, until, wait, world } from '#testkit'

describe('waiting for the state to say so', () => {
  test('a condition already true is not waiting at all', async () => {
    const seats = port(5)
    const value = await when(
      () => seats.get(),
      n => n > 3,
    )
    assert.equal(value, 5)
  })

  test('settles on the write that makes it true, and not before', async () => {
    const seats = port(0)
    let settled = false
    const waiting = when(
      () => seats.get(),
      n => n >= 2,
    ).then(value => {
      settled = true
      return value
    })

    seats.set(1)
    await settle()
    assert.equal(settled, false, 'one is not two')

    seats.set(2)
    assert.equal(await waiting, 2)
  })

  test('gives up on time, because a condition that never comes is silence', async () => {
    const clock = world()
    const seats = port(0)
    const waiting = when(
      () => seats.get(),
      n => n > 0,
      {
        timeout: 1000,
        timers: clock.timers,
      },
    ).catch((error: unknown) => error)

    await clock.advance(1200)
    const outcome = await waiting
    assert.ok(outcome instanceof Timeout)
  })

  test('an abort gives up too, with the reason it was given', async () => {
    const seats = port(0)
    const control = new AbortController()
    const waiting = when(
      () => seats.get(),
      n => n > 0,
      { signal: control.signal },
    ).catch((error: unknown) => error)

    control.abort(new Error('nobody is looking anymore'))
    const outcome = await waiting
    assert.match(String(outcome), /nobody is looking/)
  })

  test('waiting asks for the work, and lets it go when it is done', async () => {
    const asked: string[] = []
    const feed = port(0, {
      onDemand: () => asked.push('on'),
      onIdle: () => asked.push('off'),
    })
    const waiting = when(
      () => feed.get(),
      n => n > 0,
    )
    await settle()
    // Otherwise a source nobody else looks at would never load, and the wait
    // would be for something that cannot happen.
    assert.deepEqual(asked, ['on'])

    feed.set(1)
    assert.equal(await waiting, 1)
    await settle(2)
    assert.deepEqual(asked, ['on', 'off'], 'and the interest goes with the answer')
  })

  test('a cold wait is for what somebody else is keeping alive', async () => {
    const asked: string[] = []
    const feed = port(0, {
      onDemand: () => asked.push('on'),
      onIdle: () => asked.push('off'),
    })
    const waiting = when(
      () => feed.get(),
      n => n > 0,
      { cold: true },
    )
    await settle()
    assert.deepEqual(asked, [])

    feed.set(1)
    assert.equal(await waiting, 1)
  })
})

describe('a standing handler', () => {
  test('runs on what the state holds now, and on every change after', async () => {
    const owed = port(0)
    const seen: number[] = []
    until(
      whenever(
        () => owed.get(),
        value => {
          seen.push(value)
        },
      ).stop,
    )

    await settle()
    assert.deepEqual(seen, [0], 'the value it already had')

    owed.set(1)
    owed.set(2)
    await settle()
    assert.deepEqual(seen, [0, 1, 2])
  })

  test('starts silent when asked to', async () => {
    const owed = port(7)
    const seen: number[] = []
    until(
      whenever(
        () => owed.get(),
        value => {
          seen.push(value)
        },
        { now: false },
      ).stop,
    )

    await settle()
    assert.deepEqual(seen, [])
    owed.set(8)
    await settle()
    assert.deepEqual(seen, [8])
  })

  test('drops what arrives while it is busy — the default, and the safe one', async () => {
    const owed = port(0)
    const started: number[] = []
    let release = (): void => {}
    const standing = until(
      whenever(
        () => owed.get(),
        async value => {
          started.push(value)
          await new Promise<void>(resolve => {
            release = resolve
          })
        },
        { now: false },
      ).stop,
    )
    void standing

    owed.set(1)
    await settle()
    assert.deepEqual(started, [1])

    owed.set(2)
    owed.set(3)
    await settle()
    assert.deepEqual(started, [1], 'busy: the changes are ignored')

    release()
    await settle(2)
    assert.deepEqual(started, [1], 'and they are not caught up with either')
  })

  test('queued: the last value wins, because a handler catches up to the present', async () => {
    const owed = port(0)
    const started: number[] = []
    let release = (): void => {}
    until(
      whenever(
        () => owed.get(),
        async value => {
          started.push(value)
          await new Promise<void>(resolve => {
            release = resolve
          })
        },
        { now: false, whileRunning: 'queue' },
      ).stop,
    )

    owed.set(1)
    await settle()
    owed.set(2)
    owed.set(3)
    await settle()
    assert.deepEqual(started, [1])

    release()
    await settle(2)
    assert.deepEqual(started, [1, 3], 'not 2 and then 3: the history is gone')
    release()
    await settle(2)
  })

  test('restart: what is running is told to stop, so an async body can quit early', async () => {
    const owed = port(0)
    const started: number[] = []
    const quit: number[] = []
    until(
      whenever(
        () => owed.get(),
        async (value, signal) => {
          started.push(value)
          await new Promise<void>(resolve => setTimeout(resolve, 5))
          if (signal.aborted) quit.push(value)
        },
        { now: false, whileRunning: 'restart' },
      ).stop,
    )

    owed.set(1)
    await settle()
    owed.set(2)
    // Time, not turns: the bodies sleep on a real timer, and a run that has not
    // woken yet has not looked at its signal either.
    await wait(30)

    assert.deepEqual(started, [1, 2])
    assert.deepEqual(quit, [1], 'the first run learned it was abandoned')
  })

  test('stopping is final, and tells the running body so', async () => {
    const owed = port(0)
    const seen: number[] = []
    let aborted = false
    const standing = whenever(
      () => owed.get(),
      async (value, signal) => {
        seen.push(value)
        await new Promise<void>(resolve => setTimeout(resolve, 5))
        aborted = signal.aborted
      },
      { now: false },
    )

    owed.set(1)
    await settle()
    assert.equal(standing.running, true)

    standing.stop()
    // The body sleeps five milliseconds and only then reads the signal, so what
    // has to pass here is time, not turns of the queue. Waiting turns made this
    // green on one machine and red on another.
    await wait(30)
    assert.equal(aborted, true)

    owed.set(2)
    await settle()
    assert.deepEqual(seen, [1], 'nothing runs after a stop')
  })
})