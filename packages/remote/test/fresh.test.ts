import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { derived, subscribe } from '#graph'
import { source, fresh } from '#remote'
import { settle, until, world } from '#testkit'
import type { World } from '#testkit'

describe('freshness requirements', () => {
  /** A source that counts how many times the world was asked. */
  function counting(clock: World, options: Record<string, unknown> = {}) {
    let calls = 0
    const feed = source(async () => ++calls, { now: clock.now, timers: clock.timers, ...options })
    return { feed, calls: () => calls }
  }

  test('without a requirement or a pace, a source loads once per demand', async () => {
    const clock = world()
    const { feed, calls } = counting(clock)
    until(subscribe(feed.state, () => {}))
    await settle()
    assert.equal(calls(), 1)
    assert.equal(feed.pace, undefined)
    await clock.advance(10_000)
    assert.equal(calls(), 1)
  })

  test('a requirement sets the pace, withdrawing it lets the pace go', async () => {
    const clock = world()
    const { feed, calls } = counting(clock)
    until(subscribe(feed.state, () => {}))
    await settle()
    assert.equal(calls(), 1)
    const release = feed.require(100)
    assert.equal(feed.pace, 100)
    await clock.advance(250)
    assert.equal(calls(), 3)
    release()
    assert.equal(feed.pace, undefined)
    await clock.advance(1000)
    assert.equal(calls(), 3)
  })

  test('the strictest live requirement wins; when it goes, the pace relaxes', async () => {
    const clock = world()
    const { feed, calls } = counting(clock)
    until(subscribe(feed.state, () => {}))
    await settle()
    const loose = feed.require(400)
    const tight = feed.require(100)
    assert.equal(feed.pace, 100)
    await clock.advance(300)
    const fast = calls()
    assert.ok(fast >= 3, `expected the tight pace, got ${fast} calls`)
    tight()
    assert.equal(feed.pace, 400)
    await clock.advance(300)
    assert.equal(calls(), fast) // 400 has not come round yet
    loose()
  })

  test('a requirement stricter than the declared pace tightens it', async () => {
    const clock = world()
    const { feed } = counting(clock, { every: 1000 })
    until(subscribe(feed.state, () => {}))
    await settle()
    assert.equal(feed.pace, 1000)
    const release = feed.require(100)
    assert.equal(feed.pace, 100)
    release()
    assert.equal(feed.pace, 1000)
  })

  test('stating a requirement on something already too old asks at once', async () => {
    const clock = world()
    const { feed, calls } = counting(clock)
    until(subscribe(feed.state, () => {}))
    await settle()
    assert.equal(calls(), 1)
    await clock.advance(500)
    assert.equal(calls(), 1) // nobody asked for anything fresher
    const release = feed.require(100) // held value is 500ms old
    await settle()
    assert.equal(calls(), 2)
    release()
  })

  test('the floor holds, and asking below it is reported', async () => {
    const clock = world()
    const unmet: Array<{ wanted: number; floor: number }> = []
    const { feed } = counting(clock, {
      floor: 1000,
      onUnmet: (u: { wanted: number; floor: number }) =>
        unmet.push({ wanted: u.wanted, floor: u.floor }),
    })
    until(subscribe(feed.state, () => {}))
    await settle()
    const release = feed.require(50)
    assert.equal(feed.pace, 1000)
    assert.deepEqual(unmet, [{ wanted: 50, floor: 1000 }])
    release()
  })

  test('fresh(): the requirement arrives and leaves with the watcher', async () => {
    const clock = world()
    const { feed, calls } = counting(clock)
    const view = fresh(feed, 100)
    assert.equal(calls(), 0)
    const stop = subscribe(view, () => {})
    await settle()
    assert.equal(calls(), 1)
    assert.equal(feed.pace, 100)
    await clock.advance(250)
    assert.equal(calls(), 3)
    stop()
    assert.equal(feed.pace, undefined)
    assert.equal(feed.demanded, false)
    await clock.advance(1000)
    assert.equal(calls(), 3)
    assert.equal(clock.pending(), 0)
  })

  test('fresh(): two screens, two requirements, the strict one rules while it lives', async () => {
    const clock = world()
    const { feed } = counting(clock, { every: 1000 })
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
    assert.equal(clock.pending(), 0)
  })

  test('fresh(): the value reads through, formulas depend on it as usual', async () => {
    const clock = world()
    const { feed } = counting(clock, { every: 100 })
    const view = fresh(feed, 100)
    const doubled = derived(() => (view.get().value ?? 0) * 2)
    const stop = subscribe(doubled, () => {})
    await settle()
    assert.equal(doubled.peek(), 2)
    await clock.advance(100)
    assert.equal(doubled.peek(), 4)
    stop()
  })
})
