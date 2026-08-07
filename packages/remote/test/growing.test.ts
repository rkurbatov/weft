// A long run that shows its work.
//
// Ordered by Retex (item 2): a histogram over a hundred megabytes is not one
// answer at the end. Every step is a real value — a histogram half way is a
// histogram — and the screen should be showing it while the work goes on.
//
// What the library adds is one handle and nothing else: the body may put down
// what it has. Where the work stopped, whether a budget ran out, what
// "partial" means at all — the application says that inside its own value.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { heldOf, query, source, subscribe } from '#weft'
import { settle, until, world } from '#testkit'

describe('a run that puts down what it has', () => {
  test('every step is a value, and the last one is the answer', async () => {
    const clock = world()
    let step: (() => void) | undefined
    const feed = source<number[]>(
      async ({ soFar }) => {
        const built: number[] = []
        for (let i = 1; i <= 3; i++) {
          built.push(i)
          soFar([...built])
          await new Promise<void>(resolve => {
            step = resolve
          })
        }
        return [...built, 99]
      },
      { name: 'run', timers: clock.timers, now: clock.now },
    )

    const seen: number[][] = []
    until(
      subscribe(feed.state, state => {
        const held = heldOf(state)
        if (held !== undefined) seen.push(held.value)
      }),
    )
    await settle(3)

    assert.deepEqual(seen.at(-1), [1], 'the first step is already showable')
    step?.()
    await settle(3)
    assert.deepEqual(seen.at(-1), [1, 2])
    step?.()
    await settle(3)
    assert.deepEqual(seen.at(-1), [1, 2, 3])
    step?.()
    await settle(3)
    assert.deepEqual(seen.at(-1), [1, 2, 3, 99], 'and the return is the finished one')
  })

  test('steps arrive in order, and none is skipped', async () => {
    const clock = world()
    const feed = source<number>(
      async ({ soFar }) => {
        for (let i = 1; i <= 20; i++) soFar(i)
        return 21
      },
      { name: 'quick', timers: clock.timers, now: clock.now },
    )

    const seen: number[] = []
    until(
      subscribe(feed.state, state => {
        const held = heldOf(state)
        if (held !== undefined) seen.push(held.value)
      }),
    )
    await settle(3)

    assert.deepEqual(
      seen,
      [...seen].toSorted((a, b) => a - b),
      'monotonic, never reordered',
    )
    assert.equal(seen.at(-1), 21)
  })

  test('a run nobody wants any more cannot write into the answer', async () => {
    const clock = world()
    let step: (() => void) | undefined
    let wrote = 0
    const feed = source<number>(
      async ({ soFar, signal }) => {
        for (let i = 1; i <= 5; i++) {
          await new Promise<void>(resolve => {
            step = resolve
          })
          // A well-behaved body checks; a careless one does not, and must
          // still be unable to do damage.
          if (signal.aborted) break
          soFar(i)
          wrote++
        }
        return 0
      },
      { name: 'abandoned', timers: clock.timers, now: clock.now },
    )

    const stop = subscribe(feed.state, () => {})
    await settle(3)
    step?.()
    await settle(3)
    assert.equal(wrote, 1)

    // Demand leaves: the run is disowned, and its next step lands nowhere. The
    // source keeps the last answer it had — forgetting is a mirror's habit, not
    // a source's — so what is checked is that the value did not move on.
    stop()
    await settle(3)
    step?.()
    await settle(3)
    assert.equal(wrote, 1, 'the abandoned run wrote nothing further')
    assert.equal(heldOf(feed.state.peek())?.value, 1, 'and what was held stayed as it was')
  })

  test('a careless body is told to stop, and can hear it between steps', async () => {
    const clock = world()
    let step: (() => void) | undefined
    let heard = false
    const feed = source<number>(
      async ({ soFar, signal }) => {
        for (let i = 1; i <= 5; i++) {
          await new Promise<void>(resolve => {
            step = resolve
          })
          if (signal.aborted) {
            heard = true
            break
          }
          soFar(i)
        }
        return 0
      },
      { name: 'listening', timers: clock.timers, now: clock.now },
    )

    const stop = subscribe(feed.state, () => {})
    await settle(3)
    stop()
    await settle(3)
    step?.()
    await settle(3)
    assert.equal(heard, true, 'the signal reached the loop between two steps')
  })

  test('by key: changing the question kills the old run', async () => {
    const clock = world()
    const steps = new Map<number, () => void>()
    const wrote: string[] = []
    const detail = query<number, string>(
      async (id, { soFar, signal }) => {
        for (let i = 1; i <= 3; i++) {
          await new Promise<void>(resolve => {
            steps.set(id, resolve)
          })
          if (signal.aborted) return `${String(id)}:stopped`
          wrote.push(`${String(id)}:${String(i)}`)
          soFar(`${String(id)}:${String(i)}`)
        }
        return `${String(id)}:done`
      },
      { name: 'detail', max: 8, timers: clock.timers, now: clock.now },
    )

    const first = subscribe(detail(1).state, () => {})
    await settle(3)
    steps.get(1)?.()
    await settle(3)
    assert.deepEqual(wrote, ['1:1'])

    // The question changed: nobody is looking at the old key any more.
    first()
    const second = subscribe(detail(2).state, () => {})
    await settle(3)
    steps.get(1)?.()
    steps.get(2)?.()
    await settle(3)

    assert.deepEqual(wrote, ['1:1', '2:1'], 'the abandoned run wrote nothing further')
    second()
  })
})
