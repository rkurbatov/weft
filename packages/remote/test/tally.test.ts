// What a source has done, counted by the source.
//
// Written because an application counted this by hand and got it wrong in both
// directions: a run called off between two steps never got a turn to notice
// the abort, and a finished run whose question was dropped was counted as
// called off. The engine raises the abort, so the engine is the only place
// that can tell those apart.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { heldOf, source, subscribe } from '#weft'
import { settle, track, until, world } from '#testkit'

describe('a source counts what it did', () => {
  test('asked, answered, published', async () => {
    const clock = world()
    const feed = source(() => Promise.resolve('answer'), {
      name: 'plain',
      timers: clock.timers,
      now: clock.now,
    })
    until(subscribe(feed.state, () => {}))
    await settle(3)

    assert.equal(feed.tally.asked.peek(), 1)
    assert.equal(feed.tally.answered.peek(), 1)
    assert.equal(feed.tally.published.peek(), 1)
    assert.equal(feed.tally.calledOff.peek(), 0)
    assert.equal(feed.tally.refused.peek(), 0)
  })

  test('a run that reports as it goes publishes more than it answers', async () => {
    const clock = world()
    const feed = source<number>(
      async ({ soFar }) => {
        for (let i = 1; i <= 4; i++) soFar(i)
        return 5
      },
      { name: 'growing', timers: clock.timers, now: clock.now },
    )
    until(subscribe(feed.state, () => {}))
    await settle(3)

    assert.equal(feed.tally.answered.peek(), 1, 'one run finished')
    assert.equal(feed.tally.published.peek(), 5, 'four steps and the answer')
  })

  test('a run called off is counted, even if the body never looks at the signal', async () => {
    const clock = world()
    let step: (() => void) | undefined
    const feed = source<number>(
      async () => {
        // Deliberately careless: no check of the signal anywhere.
        await new Promise<void>(resolve => {
          step = resolve
        })
        return 1
      },
      { name: 'careless', timers: clock.timers, now: clock.now },
    )

    const stop = subscribe(feed.state, () => {})
    await settle(3)
    assert.equal(feed.tally.asked.peek(), 1)

    stop()
    await settle(3)
    assert.equal(feed.tally.calledOff.peek(), 1, 'demand left while the run was in flight')

    step?.()
    await settle(3)
    assert.equal(feed.tally.answered.peek(), 0, 'and its late answer is nobody’s')
  })

  test('a finished run whose question is dropped is not called off', async () => {
    const clock = world()
    const feed = source(() => Promise.resolve('answer'), {
      name: 'quick',
      timers: clock.timers,
      now: clock.now,
    })

    const stop = subscribe(feed.state, () => {})
    await settle(3)
    assert.equal(feed.tally.answered.peek(), 1)

    // The answer is in; nobody wants it any more. That is not a cancellation.
    stop()
    await settle(3)
    assert.equal(feed.tally.calledOff.peek(), 0)
  })

  test('a refusal is counted as a refusal, not as an answer', async () => {
    const clock = world()
    const feed = source(() => Promise.reject(new Error('no')), {
      name: 'sour',
      timers: clock.timers,
      now: clock.now,
    })
    until(subscribe(feed.state, () => {}))
    await settle(3)

    assert.equal(feed.tally.refused.peek(), 1)
    assert.equal(feed.tally.answered.peek(), 0)
    assert.equal(heldOf(feed.state.peek()), undefined)
  })

  test('the counters are cells: a screen watches them like anything else', async () => {
    const clock = world()
    const feed = source(() => Promise.resolve(1), {
      name: 'watched',
      timers: clock.timers,
      now: clock.now,
    })
    const seen = track(feed.tally.asked)
    until(subscribe(feed.state, () => {}))
    await settle(3)

    seen.said([1], 'it woke the watcher when it changed')
  })
})
