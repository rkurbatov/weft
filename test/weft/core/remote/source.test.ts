import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { cell, subscribe } from '#weft/core/graph/graph.ts'
import { source } from '#weft/core/remote/source.ts'
import { settle, until, world } from '../../../kit/index.ts'

describe('sources', () => {
  /** A clock and a timer queue the test drives by hand. */

  /** Let promise callbacks run. */

  test('no demand, no delivery', async () => {
    const clock = world()
    let calls = 0
    const feed = source(
      async () => {
        calls++
        return 1
      },
      { now: clock.now, timers: clock.timers },
    )
    feed.state.peek()
    const derived = cell(() => feed.state.get().value)
    derived.peek() // computed on request; nobody live behind it
    await settle()
    assert.equal(calls, 0)
    assert.equal(feed.state.peek().kind, 'empty')
  })

  test('the first watcher starts it: empty, in flight, value', async () => {
    const clock = world()
    const feed = source(async () => 'v', { now: clock.now, timers: clock.timers })
    const seen: string[] = []
    until(subscribe(feed.state, s => seen.push(s.kind)))
    assert.equal(feed.state.peek().kind, 'loading')
    await settle()
    assert.deepEqual(seen, ['loading', 'value'])
    const held = feed.state.peek()
    assert.equal(held.kind === 'value' ? held.value : undefined, 'v')
    assert.equal(held.kind === 'value' ? held.at : 0, 1000)
  })

  test('it polls while watched and stops when the last watcher goes', async () => {
    const clock = world()
    let calls = 0
    const feed = source(async () => ++calls, { every: 100, now: clock.now, timers: clock.timers })
    const stop = until(subscribe(feed.state, () => {}))
    await settle()
    assert.equal(calls, 1)
    await clock.advance(250)
    assert.equal(calls, 3)
    stop()
    assert.equal(clock.pending(), 0)
    await clock.advance(500)
    assert.equal(calls, 3)
  })

  test('within shelf life a new watcher reuses the answer; past it, a refetch', async () => {
    const clock = world()
    let calls = 0
    const feed = source(async () => ++calls, {
      shelfLife: 500,
      now: clock.now,
      timers: clock.timers,
    })
    const first = subscribe(feed.state, () => {})
    await settle()
    assert.equal(calls, 1)
    first()
    await clock.advance(100)
    const second = subscribe(feed.state, () => {})
    await settle()
    assert.equal(calls, 1) // still good
    second()
    await clock.advance(600)
    const third = subscribe(feed.state, () => {})
    await settle()
    assert.equal(calls, 2) // gone off
    third()
  })

  test('a value is kept through the next flight, so screens do not blank', async () => {
    const clock = world()
    let calls = 0
    const feed = source(async () => `answer ${++calls}`, {
      every: 100,
      now: clock.now,
      timers: clock.timers,
    })
    until(subscribe(feed.state, () => {}))
    await settle()
    assert.equal(feed.state.peek().value, 'answer 1')
    await clock.advance(100)
    assert.equal(calls, 2)
    assert.equal(feed.state.peek().value, 'answer 2')
  })

  test('refusal is a state, and it retries with growing waits', async () => {
    const clock = world()
    let calls = 0
    const feed = source(
      async () => {
        calls++
        if (calls < 3) throw new Error(`no ${calls}`)
        return 'finally'
      },
      { retry: 100, jitter: () => 0, now: clock.now, timers: clock.timers },
    )
    until(subscribe(feed.state, () => {}))
    await settle()
    const first = feed.state.peek()
    assert.equal(first.kind, 'failed')
    assert.equal(first.kind === 'failed' ? first.attempt : 0, 1)
    await clock.advance(100)
    assert.equal(calls, 2)
    await clock.advance(150) // second wait is 200, not yet
    assert.equal(calls, 2)
    await clock.advance(100)
    assert.equal(calls, 3)
    assert.equal(feed.state.peek().value, 'finally')
  })

  test('a refusal keeps the previous value beside it', async () => {
    const clock = world()
    let calls = 0
    const feed = source(
      async () => {
        calls++
        if (calls === 2) throw new Error('flaky')
        return `answer ${calls}`
      },
      { every: 100, now: clock.now, timers: clock.timers },
    )
    until(subscribe(feed.state, () => {}))
    await settle()
    await clock.advance(100)
    const state = feed.state.peek()
    assert.equal(state.kind, 'failed')
    assert.equal(state.value, 'answer 1')
  })

  test('refresh asks now, even unwatched', async () => {
    const clock = world()
    let calls = 0
    const feed = source(async () => ++calls, { now: clock.now, timers: clock.timers })
    await feed.refresh()
    assert.equal(calls, 1)
    assert.equal(feed.state.peek().value, 1)
    assert.equal(feed.demanded, false)
  })

  test('demand at the same time shares one flight; demand after a break asks anew', async () => {
    const clock = world()
    const gates: Array<(v: string) => void> = []
    const feed = source(() => new Promise<string>(resolve => gates.push(resolve)), {
      now: clock.now,
      timers: clock.timers,
    })

    // Two watchers at once: one request between them.
    const first = subscribe(feed.state, () => {})
    const second = subscribe(feed.state, () => {})
    await settle()
    assert.equal(gates.length, 1)

    // Everybody leaves mid-flight: the ask is broken off, its answer disowned.
    first()
    second()
    const third = subscribe(feed.state, () => {})
    await settle()
    assert.equal(gates.length, 2) // a fresh ask for the fresh demand
    gates[0]?.('stale, cancelled')
    gates[1]?.('v')
    await settle()
    assert.equal(feed.state.peek().value, 'v')
    third()
  })

  test('a forced refresh disowns the older answer', async () => {
    const clock = world()
    const gates: Array<(v: string) => void> = []
    const feed = source(() => new Promise<string>(resolve => gates.push(resolve)), {
      now: clock.now,
      timers: clock.timers,
    })
    until(subscribe(feed.state, () => {}))
    await settle()
    void feed.refresh()
    await settle()
    assert.equal(gates.length, 2)
    gates[1]?.('fresh')
    await settle()
    gates[0]?.('stale')
    await settle()
    assert.equal(feed.state.peek().value, 'fresh')
  })

  test('a formula over a source sees only its own value change', async () => {
    const clock = world()
    let calls = 0
    const feed = source(async () => ({ id: 1, hits: ++calls }), {
      every: 100,
      now: clock.now,
      timers: clock.timers,
    })
    const id = cell(() => feed.state.get().value?.id)
    let woke = 0
    until(subscribe(id, () => woke++))
    await settle()
    assert.equal(woke, 1) // nothing -> 1, the only real change
    await clock.advance(300)
    assert.ok(calls >= 3, `calls ${calls}`)
    assert.equal(woke, 1) // hits kept changing; id did not
    assert.equal(id.peek(), 1)
  })

  test('retry wait carries the injected spread', async () => {
    const clock = world()
    let calls = 0
    const feed = source(
      async () => {
        calls++
        throw new Error('down')
      },
      { retry: 100, jitter: () => 0.5, now: clock.now, timers: clock.timers },
    )
    until(subscribe(feed.state, () => {}))
    await settle()
    assert.equal(calls, 1)
    await clock.advance(49) // full jitter: wait is 100 * (1 - 0.5) = 50
    assert.equal(calls, 1)
    await clock.advance(1)
    assert.equal(calls, 2)
  })

  test('a permanent refusal lies still: no retry by itself, a refresh asks anew', async () => {
    const clock = world()
    let calls = 0
    const feed = source(
      async () => {
        calls++
        throw new Error('404: no such thing')
      },
      {
        retry: 100,
        jitter: () => 0,
        classify: () => 'permanent',
        now: clock.now,
        timers: clock.timers,
      },
    )
    until(subscribe(feed.state, () => {}))
    await settle()
    const refusal = feed.state.peek()
    assert.equal(refusal.kind === 'failed' && refusal.fault, 'permanent')

    await clock.advance(10_000)
    assert.equal(calls, 1) // nothing retried what cannot pass by itself

    void feed.refresh() // a person or a fact asked again — that is allowed
    await settle()
    assert.equal(calls, 2)
  })

  test('no answer in time is unknown, and the late answer is disowned', async () => {
    const clock = world()
    const gates: Array<(value: string) => void> = []
    const feed = source(() => new Promise<string>(resolve => gates.push(resolve)), {
      timeout: 1000,
      now: clock.now,
      timers: clock.timers,
    })
    until(subscribe(feed.state, () => {}))
    await settle()

    await clock.advance(1000)
    const state = feed.state.peek()
    assert.equal(state.kind, 'failed')
    assert.equal(state.kind === 'failed' && state.fault, 'unknown')

    gates[0]?.('answered after everyone stopped waiting')
    await settle()
    assert.equal(feed.state.peek().kind, 'failed') // the late answer changed nothing
  })

  test('losing demand breaks the ask off: the loader is told through its signal', async () => {
    const clock = world()
    let seen: AbortSignal | undefined
    const feed = source(
      ({ signal }) =>
        new Promise<string>(() => {
          seen = signal
        }),
      { now: clock.now, timers: clock.timers },
    )
    const stop = until(subscribe(feed.state, () => {}))
    await settle()
    assert.equal(seen?.aborted, false)

    stop() // the last watcher leaves mid-flight
    await settle()
    assert.equal(seen?.aborted, true)
  })

  test('calm: a look that leaves during the quiet asks nothing', async () => {
    const clock = world()
    let asked = 0
    const feed = source(
      () => {
        asked++
        return Promise.resolve(asked)
      },
      { name: 'calmed', calm: 300, timers: clock.timers, now: clock.now },
    )

    const stop = until(subscribe(feed.state, () => {}))
    await clock.advance(100)
    stop() // the look left before the quiet ran out
    await clock.advance(1000)
    assert.equal(asked, 0)

    const again = subscribe(feed.state, () => {})
    await clock.advance(299)
    assert.equal(asked, 0)
    await clock.advance(1)
    assert.equal(asked, 1) // the look survived the quiet: one question
    again()
  })

  test('calm delays the first ask only; the pace ticks without it', async () => {
    const clock = world()
    const times: number[] = []
    const feed = source(
      () => {
        times.push(clock.now())
        return Promise.resolve(times.length)
      },
      { name: 'paced', calm: 100, every: 200, timers: clock.timers, now: clock.now },
    )
    const stop = until(subscribe(feed.state, () => {}))
    await clock.advance(600)
    stop()
    // First at 1000+100 (after the quiet); then every 200, with no extra quiet.
    assert.deepEqual(times, [1100, 1300, 1500])
  })
})
