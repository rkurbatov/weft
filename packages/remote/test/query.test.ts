import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { subscribe } from '#graph'
import { query } from '#remote'
import { heldOf } from '#remote'
import { settle, world } from '#testkit'

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
    const first = subscribe(user(7).state, () => {})
    const second = subscribe(user(7).state, () => {})
    await settle()
    assert.equal(calls, 1)
    assert.equal(user(7).state.peek().value, 'user 7')
    first()
    second()
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
    const stop = subscribe(user(5).state, () => {})
    await settle()
    assert.equal(user(5).state.peek().kind, 'failed')
    stop()
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
    assert.equal(user.sweep(), 3)
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
