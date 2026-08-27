import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { derived, subscribe, trace } from '#graph'
import { fresh, query } from '#remote'
import { heldOf } from '#remote'
import { settle, until, world } from '#testkit'

describe('parametric queries', () => {
  test('the same key hands back the same source: two screens share one request', async () => {
    const clock = world()
    let calls = 0
    const user = query(
      async (id: number) => {
        calls++
        return `user ${id}`
      },
      { max: 100, now: clock.now, timers: clock.timers },
    )

    assert.equal(user(7), user(7))
    until(subscribe(user(7).state, () => {}))
    until(subscribe(user(7).state, () => {}))
    await settle()
    assert.equal(calls, 1)
    assert.equal(user(7).state.peek().value, 'user 7')
  })

  test('a screen moving to another key leaves nothing to race: cells are per key', async () => {
    const clock = world()
    const gates = new Map<number, (value: string) => void>()
    const user = query((id: number) => new Promise<string>(resolve => gates.set(id, resolve)), {
      max: 100,
      now: clock.now,
      timers: clock.timers,
    })

    let stop = subscribe(user(1).state, () => {})
    await settle()
    stop()
    stop = subscribe(user(2).state, () => {})
    await settle()

    gates.get(2)?.('two')
    await settle()
    gates.get(1)?.('one, late') // the slow answer for the old key
    await settle()

    assert.equal(user(2).state.peek().value, 'two')
    stop()
  })

  test('policies are stated once for the family', async () => {
    const clock = world()
    const calls: number[] = []
    const user = query(
      async (id: number) => {
        calls.push(id)
        if (calls.length === 1) throw new Error('flaky once')
        return `user ${id}`
      },
      { max: 100, retry: 100, jitter: () => 0, now: clock.now, timers: clock.timers },
    )
    until(subscribe(user(5).state, () => {}))
    await settle()
    assert.equal(user(5).state.peek().kind, 'failed')
  })

  test('the ceiling drops the coldest unwatched member, never a watched one', async () => {
    const clock = world()
    const user = query(async (id: number) => `user ${id}`, {
      max: 2,
      now: clock.now,
      timers: clock.timers,
    })

    const stop = subscribe(user(1).state, () => {}) // watched
    user(2)
    user(3)
    assert.equal(user.size, 3) // 1 is watched and does not count against the two
    user(4) // 2 is the coldest unwatched; it goes
    assert.equal(user.size, 3)
    assert.equal(user.evict(1), false) // watched, never dropped
    stop()
    // Letting the reader go makes 1 a cache entry, which puts the cache one
    // over its ceiling: it is kept there and then, without waiting for anybody
    // to ask a new question.
    assert.equal(user.size, 2, 'cooling restores the ceiling without another key')
    assert.equal(user.sweep(), 2)
    assert.equal(user.size, 0)
  })

  test('a reader that asks for nothing still holds the source it waits on', async () => {
    const clock = world()
    const user = query(async (id: number) => `user ${id}`, {
      max: 1,
      now: clock.now,
      timers: clock.timers,
    })
    // Two shapes of the same thing, and the cache must not tell them apart: a
    // watcher that deliberately raises no demand, and a formula read once and
    // left linked. Neither asks the source to work; both wait to hear from it.
    //
    // Negative control: retain by `demanded` instead of by being read, and both
    // halves of this go red.
    const first = user(1)
    const stopCold = subscribe(first.state, () => {}, { demand: false })
    user(2)
    assert.equal(user(1), first, 'the cold watcher kept the source it watches')
    assert.equal(user.evict(1), false)
    stopCold()

    const second = user(3)
    const bridge = derived(() => second.state.get())
    bridge.peek()
    user(4)
    assert.equal(user(3), second, 'and so did the formula that read it once')
    assert.equal(user.evict(3), false)
    bridge.dispose()
  })

  test('a source the cache let go of no longer reports to it', async () => {
    const clock = world()
    const user = query(async (id: number) => `user ${id}`, {
      max: 1,
      now: clock.now,
      timers: clock.timers,
    })
    const first = user(1)
    user(2) // 1 is the coldest and goes
    assert.equal(user.size, 1)
    // The caller still holds the old handle. Reading it now must not walk it
    // back into a cache that let go of it.
    //
    // Negative control: leave the keeper on an evicted source and this grows.
    const stop = subscribe(first.state, () => {})
    assert.equal(user.size, 1)
    assert.equal(user(1) === first, false, 'the key builds a fresh source, as it should')
    assert.equal(user.size, 1, 'and the old one did not walk back in beside it')
    stop()
  })

  test('the member just asked for is never the one dropped to make room', async () => {
    const clock = world()
    // A cache told to keep nothing still has to hand back what it was asked
    // for: a source dropped on its way out to the caller means two requests
    // over the wire for one answer, and two states for one question.
    const user = query(async (id: number) => `user ${id}`, {
      max: 0,
      now: clock.now,
      timers: clock.timers,
    })
    const one = user(1)
    assert.equal(user(1), one)
    assert.equal(user.size, 1)
    user(2)
    assert.equal(user.size, 1) // the first is cold and goes; the newborn stays
  })

  test('keys of different kinds are different questions', () => {
    // Negative control: name a key by `String(key)` alone and every one of
    // these pairs collapses into one member.
    const mixed = query(async (key: string | number | boolean | bigint) => key, { max: 10 })
    assert.notEqual(mixed(1), mixed('1'))
    assert.notEqual(mixed(true), mixed('true'))
    assert.notEqual(mixed(1), mixed(1n))
    assert.equal(mixed.size, 5)
  })

  test('a freshness view stops holding the source when its last reader goes', async () => {
    const clock = world()
    const user = query(async (id: number) => `user ${id}`, {
      max: 1,
      now: clock.now,
      timers: clock.timers,
    })
    const first = user(1)
    const view = fresh(first, 100)
    const stop = subscribe(view, () => {})
    stop()
    await settle(2)

    // Two levels of the same law. What the adapter holds:
    //
    // Negative control: build `fresh` from an ordinary cell and both halves go
    // red — the requirement leaves with the watcher, but the edge does not.
    assert.deepEqual(trace(view).reads, [], 'the view let the source go')

    // And what it means for whoever uses the cache:
    user(2)
    assert.notEqual(user(1), first, 'so the source is an ordinary cache entry again')
    assert.equal(user.size, 1)
  })

  test('the ceiling is restored on a second wave of cooling as well as the first', async () => {
    // Negative control: drop the reset of the queued flag and the second wave
    // never gets a trim, because the cache still believes one is standing.
    const clock = world()
    const user = query(async (id: number) => `user ${id}`, {
      max: 1,
      now: clock.now,
      timers: clock.timers,
    })
    const one = user(1)
    for (const wave of [1, 2]) {
      const stop = subscribe(one.state, () => {}, { demand: false })
      user(2)
      stop()
      await settle(2)
      assert.equal(user.size, 1, `wave ${String(wave)}`)
    }
  })

  test('a cold reader of a freshness view holds the source without waking it', async () => {
    const clock = world()
    let calls = 0
    const user = query(
      async (id: number) => {
        calls++
        return `user ${id}`
      },
      { max: 1, now: clock.now, timers: clock.timers },
    )
    const first = user(1)
    const view = fresh(first, 100)
    // The whole difference between the two questions in one scene, on four
    // coordinates: the identity is held, no demand is raised, no freshness is
    // required, and no work is started.
    //
    // Negative controls: retain by demand and the identity is lost; hang the
    // requirement on being read and a pace of 100 appears; start a load from
    // being read and the count of calls does.
    const stop = subscribe(view, () => {}, { demand: false })
    await settle(3)
    user(2)
    assert.equal(user(1), first, 'read, so its identity is held')
    assert.equal(user.evict(1), false)
    assert.equal(first.demanded, false, 'and not asked, so it is not working')
    assert.equal(first.pace, undefined, 'and no freshness is required of it')
    assert.equal(calls, 0, 'and nothing was asked of the world')
    assert.equal(user.tally.asked.peek(), 0)
    stop()
    await settle(2)
    assert.equal(user.size, 1, 'and when the reader goes, the ceiling comes back')
  })

  test('a ceiling is a whole count of none or more', () => {
    // Negative control: take the number as given and -1, 0.5 and NaN each
    // quietly keep one member while Infinity turns the cache unbounded behind
    // the word meant to say so.
    // Safe, not merely whole: past MAX_SAFE_INTEGER a cache cannot count up to
    // its own ceiling, so `Number.isInteger` in place of `isSafeInteger` must go
    // red here.
    for (const bad of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assert.throws(() => query(async (id: number) => id, { max: bad }), RangeError)
    }
    assert.doesNotThrow(() => query(async (id: number) => id, { max: 0 }))
    assert.doesNotThrow(() => query(async (id: number) => id, { max: Number.MAX_SAFE_INTEGER }))
    assert.doesNotThrow(() => query(async (id: number) => id, { max: 'unbounded' }))
  })

  test('object keys need keyOf, and get their own member each', async () => {
    const clock = world()
    const page = query(async (at: { list: string; page: number }) => `${at.list}#${at.page}`, {
      max: 10,
      keyOf: at => `${at.list}:${at.page}`,
      now: clock.now,
      timers: clock.timers,
    })
    assert.equal(page({ list: 'inbox', page: 1 }), page({ list: 'inbox', page: 1 }))
    assert.notEqual(page({ list: 'inbox', page: 1 }), page({ list: 'inbox', page: 2 }))

    const bare = query(async (key: object) => key, { max: 10, now: clock.now })
    assert.throws(() => bare({}), /keyOf/)
  })

  test('a churn of questions asks only the one that survived the calm', async () => {
    const clock = world()
    const asked: string[] = []
    const find = query(
      (key: string) => {
        asked.push(key)
        return Promise.resolve(`found ${key}`)
      },
      { name: 'find', max: 'unbounded', calm: 200, timers: clock.timers, now: clock.now },
    )

    // Typing: each keystroke moves the look to the next question.
    let stop = subscribe(find('h').state, () => {})
    await clock.advance(50)
    stop()
    stop = subscribe(find('he').state, () => {})
    await clock.advance(50)
    stop()
    stop = subscribe(find('hel').state, () => {})
    await clock.advance(500)
    stop()

    assert.deepEqual(asked, ['hel']) // the abandoned questions were never asked
  })

  test('precedence: the answer to a devalued question is not accepted', async () => {
    const clock = world()
    let release: (value: string) => void = () => {}
    const slow = new Promise<string>(resolve => {
      release = resolve
    })
    const find = query((key: string) => (key === 'old' ? slow : Promise.resolve(`found ${key}`)), {
      name: 'find',
      max: 'unbounded',
      timers: clock.timers,
      now: clock.now,
    })

    const old = find('old')
    let stop = subscribe(old.state, () => {})
    await clock.advance(10) // the old question is in flight
    stop()
    stop = subscribe(find('new').state, () => {}) // the look moved on
    await clock.advance(10)

    release('found old') // the late answer limps in
    await clock.advance(10)
    assert.equal(heldOf(old.state.peek()), undefined) // and is not accepted
    assert.equal(heldOf(find('new').state.peek())?.value, 'found new')
    stop()
  })
})
