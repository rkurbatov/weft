// A pace for the wire: no oftener than once every so often, and the last
// value always arrives.
//
// Ordered by Retex (З-5): folds of a long run must reach a panel about ten
// times a second, not a thousand. What matters is the pair of promises — the
// rate is kept under a storm, and nothing is lost at the end of one — so both
// are tested here rather than watched on a page.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { every, link, serve } from '#link'
import { heldOf, port, subscribe, wirePair } from '#weft'
import { settle, until, world } from '#testkit'

describe('every: a pace the wire keeps', () => {
  test('a storm of writes becomes one flush per interval', async () => {
    const clock = world()
    let flushes = 0
    const schedule = every(100, clock.timers)

    for (let i = 0; i < 50; i++) schedule(() => flushes++)
    assert.equal(flushes, 1, 'the first one goes at once — a screen should not wait')

    await clock.advance(100)
    assert.equal(flushes, 2, 'and the storm settles into one more')

    await clock.advance(100)
    assert.equal(flushes, 2, 'nothing further was owed')
  })

  test('the last value arrives after the storm, without another write', async () => {
    const clock = world()
    const seen: number[] = []
    const schedule = every(100, clock.timers)

    for (let i = 1; i <= 20; i++) schedule(() => seen.push(i))
    await clock.advance(500)

    assert.deepEqual(seen, [1, 20], 'the first, then the state after the last write')
  })

  test('a slow trickle is not delayed by the pace', async () => {
    const clock = world()
    let flushes = 0
    const schedule = every(100, clock.timers)

    for (let i = 0; i < 5; i++) {
      schedule(() => flushes++)
      await clock.advance(150)
    }
    assert.equal(flushes, 5, 'each was alone in its interval, so each went at once')
  })

  test('through the wire: a hundred writes reach the panel ten times, not a hundred', async () => {
    const clock = world()
    const seats = port(0, { name: 'seats' })
    const wire = wirePair()
    until(serve({ cells: { seats } }, wire.graph, { schedule: every(100, clock.timers) }))

    const watcher = link(wire.watcher)
    until(watcher.close)
    const mirror = watcher.derived<number>('seats')
    let landed = 0
    until(
      subscribe(mirror, () => {
        landed++
      }),
    )
    await settle(3)

    const before = landed
    // Ten writes per interval, ten intervals: a thousand-write run at the pace
    // Retex asks for.
    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < 10; i++) seats.set(round * 10 + i)
      await clock.advance(100)
      await settle(2)
    }
    await clock.advance(200)
    await settle(3)

    assert.ok(
      landed - before <= 12,
      `the panel woke ${String(landed - before)} times, not a hundred`,
    )
    assert.equal(heldOf(mirror.peek())?.value, 99, 'and the last value is the one it holds')
  })
})
