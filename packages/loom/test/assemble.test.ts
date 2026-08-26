// The assembly word, on all three wirings.
//
// What is checked is not the plumbing — that has its own tests one layer down —
// but the promise of the word: whatever the wiring, a screen gets the same
// face, and stopping lets go of both ends.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { cell, inMemory, loom, offer, sends, station, tabs, will } from '#loom'
import type { Station } from '#loom'
import { atOnce, wirePair } from '#weft'
import type { Lock } from '#wire'
import { settle } from '#testkit'
import { forgetNotices, onNotice } from '#core'

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

  test('the face keeps the station’s names and types across the wiring', async () => {
    // Declared once, on the station, and read back with the names checked: no
    // `view<number>('seats')` restating a type the declaration already knew,
    // and no string the compiler cannot see is wrong.
    const front = () => {
      const seats = cell(1)
      const note = cell('open')
      return station(
        {
          views: { note },
          // `seats` is named once. It is written into, and it can be read, so
          // it is published as itself rather than declared a second time.
          facts: { seats },
          acts: { take: (many: number) => seats.set(seats.get() + many) },
        },
        { schedule: atOnce },
      )
    }

    const app = loom({ name: 'desk.typed', station: front }, { wire: inMemory() })
    const stop = app.warm(['seats', 'note'])
    await settle()

    assert.equal(app.face.views.seats.get(), 1, 'a fact is readable without a second declaration')
    assert.equal(app.face.views.note.get(), 'open')

    await app.face.acts.take(2)
    await settle()
    assert.equal(app.face.views.seats.get(), 3)

    app.face.facts.seats(10)
    await settle()
    assert.equal(app.face.views.seats.get(), 10, 'a fact writes through under its own name')

    const wrong = (): void => {
      // @ts-expect-error — no such view on this station
      void app.face.views.chairs
      // @ts-expect-error — no such act either
      void app.face.acts.leave
      // @ts-expect-error — take counts seats, and a count is a number
      void app.face.acts.take('two')
    }
    void wrong

    stop()
    app.stop()
  })

  test('the signed-in session is said once and inherited by what needs an owner', async () => {
    // A book of unsent intents cannot be anonymous, and the application knows
    // whose screen this is exactly once — here. Saying it at every `will()`
    // was the same fact written down as many times as there were intents.
    const heard: string[] = []
    const stopHearing = onNotice(what => heard.push(what.kind))
    let shelf: string | undefined
    const front = () => {
      const post = will({ ping: sends<number>(() => Promise.resolve()) }, { name: 'book' })
      shelf = post.shelf
      return station({ views: { owed: post.owed } }, { schedule: atOnce })
    }

    const app = loom({ name: 'desk.owned', session: 'ann', station: front }, { wire: inMemory() })
    stopHearing()
    // No browser database in a test runner, so the best an owner can get here
    // is memory — but it was opened as an owned book, and nothing complained.
    assert.equal(shelf, 'memory')
    assert.equal(heard.includes('unowned-book'), false, 'the assembly’s session was not inherited')
    app.stop()
  })

  test('with no session named, nothing durable opens itself', async () => {
    const heard: string[] = []
    const stopHearing = onNotice(what => heard.push(what.kind))
    const front = () => {
      const post = will({ ping: sends<number>(() => Promise.resolve()) }, { name: 'book.loose' })
      return station({ views: { owed: post.owed } }, { schedule: atOnce })
    }
    forgetNotices()
    const app = loom({ name: 'desk.loose', station: front })
    stopHearing()
    // Also: no wiring said at all. The state living right here is the common
    // case, and a line that carries no decision is noise.
    assert.equal(app.role.get(), 'inline')
    assert.equal(heard.includes('unowned-book'), true, 'an anonymous book passed in silence')
    app.stop()
  })

  test('two sessions of one application do not share a station', async () => {
    // The book was already apart; the screen was not. Tabs elect by a name, and
    // two sessions of one application shared it — so one led and handed the
    // other every view, fact and act it had.
    const locks = new Map<string, { held: boolean; waiting: Array<() => void> }>()
    const lock: Lock = {
      hold(name, whileHeld) {
        const at = locks.get(name) ?? { held: false, waiting: [] }
        locks.set(name, at)
        const take = (): void => {
          at.held = true
          const release = whileHeld()
          void release
        }
        if (at.held) at.waiting.push(take)
        else take()
        return () => {}
      },
    }

    const front = (who: string) => () =>
      station({ views: { whose: cell(who) } }, { schedule: atOnce })

    const ann = loom(
      { name: 'same-app', session: 'ann', station: front('ann') },
      { wire: tabs({ lock }) },
    )
    const bob = loom(
      { name: 'same-app', session: 'bob', station: front('bob') },
      { wire: tabs({ lock }) },
    )
    const stopAnn = ann.warm(['whose'])
    const stopBob = bob.warm(['whose'])
    await settle(6)

    assert.equal(ann.face.views.whose.get(), 'ann')
    assert.equal(bob.face.views.whose.get(), 'bob', 'bob was handed ann’s screen')
    // Neither waits on the other: they held separate elections.
    assert.equal(ann.role.get(), 'leading')
    assert.equal(bob.role.get(), 'leading')

    stopAnn()
    stopBob()
    ann.stop()
    bob.stop()
  })
})
