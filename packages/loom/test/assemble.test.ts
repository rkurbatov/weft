// The assembly word, on all three wirings.
//
// What is checked is not the plumbing — that has its own tests one layer down —
// but the promise of the word: whatever the wiring, a screen gets the same
// face, and stopping lets go of both ends.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { cell, inMemory, loom, offer, tabs } from '#loom'
import type { Station } from '#loom'
import { atOnce, wirePair } from '#weft'
import type { Lock } from '#wire'
import { settle } from '#testkit'

const desk = (): Station => {
  const seats = cell(1)
  return {
    serve: channel =>
      offer(
        { views: { seats }, facts: { seats }, acts: { take: () => seats.set(seats.get() + 1) } },
        channel,
        { schedule: atOnce },
      ),
  }
}

describe('assembling a screen over a station', () => {
  test('in memory: the face answers, and the role says the work is here', async () => {
    const app = loom({ name: 'desk.inline', station: desk }, { wire: inMemory() })
    // Warm: a mirror is fed while somebody looks at it, and nobody is looking
    // at a value read once from a test.
    const stop = app.warm(['seats'])
    const seats = app.view<number>('seats')
    await settle()
    assert.equal(seats.get(), 1)
    assert.equal(app.role.get(), 'inline')

    await app.act<[], void>('take')()
    await settle()
    assert.equal(seats.get(), 2, 'an act on the station shows up on the screen')

    stop()
    app.stop()
  })

  test('tabs: the first screen leads, and a second one follows it', async () => {
    // A lock of our own rather than the browser's: the platform grows
    // capabilities, and a sniff is not a contract.
    let holder: boolean = false
    const waiting: Array<() => void> = []
    const lock: Lock = {
      hold: (_name, onHeld) => {
        if (!holder) {
          holder = true
          onHeld()
          return () => {
            holder = false
            waiting.shift()?.()
          }
        }
        let mine = false
        const take = (): void => {
          mine = true
          holder = true
          onHeld()
        }
        waiting.push(take)
        return () => {
          if (mine) holder = false
        }
      },
    }

    const first = loom({ name: 'desk.tabs', station: desk }, { wire: tabs({ lock }) })
    await settle()
    assert.equal(first.role.get(), 'leading', 'the first one in does the work')

    const second = loom({ name: 'desk.tabs', station: desk }, { wire: tabs({ lock }) })
    await settle()
    assert.equal(second.role.get(), 'following', 'the next one mirrors instead')

    second.stop()
    first.stop()
  })

  test('a worker: the station is over there, and this side only mirrors', async () => {
    // A pair stands in for the worker. `worker()` wraps a port-shaped thing in
    // a channel; a pair hands out channels already, so the wiring is stated
    // directly here — what is under test is `loom`, not the wrapping.
    const pair = wirePair()
    const built = desk()
    const stopStation = built.serve(pair.graph)

    const app = loom({ name: 'desk.worker' }, { wire: { kind: 'worker', channel: pair.watcher } })
    const stop = app.warm(['seats'])
    const seats = app.view<number>('seats')
    await settle()
    assert.equal(seats.get(), 1)
    assert.equal(app.role.get(), 'following', 'the work is on the other side')

    stop()
    app.stop()
    stopStation()
  })

  test('a wiring that builds a station here is told when there is none', () => {
    assert.throws(() => loom({ name: 'desk.none' }, { wire: inMemory() }), /station is needed/)
  })
})
