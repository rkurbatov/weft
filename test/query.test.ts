import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subscribe } from '#core/graph.ts'
import { query } from '#core/query.ts'
import { heldOf } from '#core/remote.ts'
import type { Timers } from '#core/time.ts'

function fakeWorld(start = 1000) {
  let time = start
  let next = 1
  const jobs = new Map<number, { at: number; fn: () => void }>()
  const timers: Timers = {
    set: (fn, ms) => {
      const id = next++
      jobs.set(id, { at: time + ms, fn })
      return id
    },
    clear: handle => {
      jobs.delete(handle as number)
    },
  }
  return {
    timers,
    now: () => time,
    /** Move time forward, firing whatever comes due. */
    async advance(ms: number) {
      const until = time + ms
      for (;;) {
        const due = [...jobs.entries()]
          .filter(([, job]) => job.at <= until)
          .toSorted((a, b) => a[1].at - b[1].at)[0]
        if (due === undefined) break
        const [id, job] = due
        jobs.delete(id)
        time = job.at
        job.fn()
        await settle()
      }
      time = until
      await settle()
    },
  }
}

function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

test('the same key hands back the same source: two screens share one request', async () => {
  const world = fakeWorld()
  let calls = 0
  const user = query(
    async (id: number) => {
      calls++
      return `user ${id}`
    },
    { max: 100, now: world.now, timers: world.timers },
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
  const world = fakeWorld()
  const gates = new Map<number, (value: string) => void>()
  const user = query((id: number) => new Promise<string>(resolve => gates.set(id, resolve)), {
    max: 100,
    now: world.now,
    timers: world.timers,
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
  const world = fakeWorld()
  const calls: number[] = []
  const user = query(
    async (id: number) => {
      calls.push(id)
      if (calls.length === 1) throw new Error('flaky once')
      return `user ${id}`
    },
    { max: 100, retry: 100, jitter: () => 0, now: world.now, timers: world.timers },
  )
  const stop = subscribe(user(5).state, () => {})
  await settle()
  assert.equal(user(5).state.peek().kind, 'failed')
  stop()
})

test('the ceiling drops the coldest unwatched member, never a watched one', async () => {
  const world = fakeWorld()
  const user = query(async (id: number) => `user ${id}`, {
    max: 2,
    now: world.now,
    timers: world.timers,
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
  const world = fakeWorld()
  const page = query(async (at: { list: string; page: number }) => `${at.list}#${at.page}`, {
    max: 10,
    keyOf: at => `${at.list}:${at.page}`,
    now: world.now,
    timers: world.timers,
  })
  assert.equal(page({ list: 'inbox', page: 1 }), page({ list: 'inbox', page: 1 }))
  assert.notEqual(page({ list: 'inbox', page: 1 }), page({ list: 'inbox', page: 2 }))

  const bare = query(async (key: object) => key, { max: 10, now: world.now })
  assert.throws(() => bare({}), /keyOf/)
})

test('a churn of questions asks only the one that survived the calm', async () => {
  const world = fakeWorld()
  const asked: string[] = []
  const find = query(
    (key: string) => {
      asked.push(key)
      return Promise.resolve(`found ${key}`)
    },
    { name: 'find', max: 'unbounded', calm: 200, timers: world.timers, now: world.now },
  )

  // Typing: each keystroke moves the look to the next question.
  let stop = subscribe(find('h').state, () => {})
  await world.advance(50)
  stop()
  stop = subscribe(find('he').state, () => {})
  await world.advance(50)
  stop()
  stop = subscribe(find('hel').state, () => {})
  await world.advance(500)
  stop()

  assert.deepEqual(asked, ['hel']) // the abandoned questions were never asked
})

test('precedence: the answer to a devalued question is not accepted', async () => {
  const world = fakeWorld()
  let release: (value: string) => void = () => {}
  const slow = new Promise<string>(resolve => {
    release = resolve
  })
  const find = query((key: string) => (key === 'old' ? slow : Promise.resolve(`found ${key}`)), {
    name: 'find',
    max: 'unbounded',
    timers: world.timers,
    now: world.now,
  })

  const old = find('old')
  let stop = subscribe(old.state, () => {})
  await world.advance(10) // the old question is in flight
  stop()
  stop = subscribe(find('new').state, () => {}) // the look moved on
  await world.advance(10)

  release('found old') // the late answer limps in
  await world.advance(10)
  assert.equal(heldOf(old.state.peek()), undefined) // and is not accepted
  assert.equal(heldOf(find('new').state.peek())?.value, 'found new')
  stop()
})
