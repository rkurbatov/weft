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
        { atStart: false },
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
        { atStart: false },
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
        { atStart: false, whileRunning: 'queue' },
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

  test('queued: a body that throws does not tear the microtask queue', async () => {
    // The queued run fires inside a promise's `finally`. A synchronous throw
    // there used to escape as an UNHANDLED REJECTION — a crash in Node, a
    // silent stop in a worker — instead of the uncaught exception the
    // asynchronous branch deliberately raises. The test runner rightly fails
    // a file on either, so the scene runs in a child process, where the two
    // outcomes can be told apart: a rejection kills the child before its
    // listener hears anything; the exception lands in the listener and the
    // handler goes on to take the next value.
    const scene = `
      import { port } from '#graph'
      import { whenever } from '#loom'
      const landed = []
      process.on('uncaughtException', error => landed.push(error.message))
      const owed = port(0)
      const started = []
      let release = () => {}
      whenever(
        () => owed.get(),
        value => {
          started.push(value)
          if (value === 2) throw new Error('thrown from the queue')
          if (value === 1) return new Promise(resolve => { release = resolve })
          return undefined
        },
        { atStart: false, whileRunning: 'queue' },
      )
      const turn = () => new Promise(resolve => setTimeout(resolve, 0))
      owed.set(1); await turn()
      owed.set(2); await turn() // queued behind the running 1
      release(); await turn(); await turn()
      owed.set(3); await turn() // the handler must still stand
      console.log(JSON.stringify({ started, landed }))
    `
    const { execFile } = await import('node:child_process')
    const answer = await new Promise<{ code: number | null; out: string }>(resolve => {
      const child = execFile(
        process.execPath,
        ['--input-type=module', '--no-warnings', '-e', scene],
        { cwd: process.cwd() },
        (error, stdout) => resolve({ code: error === null ? 0 : 1, out: stdout }),
      )
      void child
    })
    assert.equal(answer.code, 0, 'the child survived the throw')
    const seen = JSON.parse(answer.out) as { started: number[]; landed: string[] }
    assert.deepEqual(seen.started, [1, 2, 3], 'the queue took the throw and stood')
    assert.deepEqual(seen.landed, ['thrown from the queue'], 'the error came out where errors do')
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
        { atStart: false, whileRunning: 'restart' },
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

  test('a restarted run does not clear the bookkeeping of the one that replaced it', async () => {
    // The abandoned run's `finally` used to set `running` back to false and
    // drop `abort` — the record of the NEWER run, wiped by its predecessor.
    // After that a third value started a second body beside the live one.
    const owed = port(0)
    const started: number[] = []
    const ended: number[] = []
    const standing = whenever(
      () => owed.get(),
      async value => {
        started.push(value)
        // The second run outlives the first by a wide margin, so the first
        // finishes while the second is still going.
        await new Promise<void>(resolve => setTimeout(resolve, value === 1 ? 5 : 60))
        ended.push(value)
      },
      { atStart: false, whileRunning: 'restart' },
    )
    until(standing.stop)

    owed.set(1)
    await settle()
    owed.set(2) // restarts: run 1 is abandoned but still sleeping
    await wait(25) // run 1 has now finished; run 2 is still going

    assert.deepEqual(started, [1, 2])
    assert.equal(standing.running, true, 'the live run was reported as finished')

    owed.set(3)
    await settle()
    assert.deepEqual(started, [1, 2, 3], 'a third body started beside the live one')
  })

  test('stop reaches the run that is actually going', async () => {
    const owed = port(0)
    const quit: number[] = []
    const standing = whenever(
      () => owed.get(),
      async (value, signal) => {
        await new Promise<void>(resolve => setTimeout(resolve, value === 1 ? 5 : 60))
        if (signal.aborted) quit.push(value)
      },
      { atStart: false, whileRunning: 'restart' },
    )
    until(standing.stop)

    owed.set(1)
    await settle()
    owed.set(2)
    await wait(25) // the abandoned run is over; the live one is not
    standing.stop()
    await wait(60)

    assert.deepEqual(quit, [1, 2], 'stop aborted a controller nobody was listening to')
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
      { atStart: false },
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
