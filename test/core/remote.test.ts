import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY, arrived, firstOf, heldOf, loading, refused, together } from '#core/remote.ts'
import type { Remote } from '#core/remote.ts'

const value = <T>(v: T, at: number): Remote<T> => arrived(v, at)
const flight = <T>(previous: Remote<T>, since = 50): Remote<T> => loading(previous, since)
const no = <T>(previous: Remote<T>, why: string): Remote<T> =>
  refused(previous, new Error(why), 1, 'transient')

test('together: value when every part holds, as old as the oldest part', () => {
  const both = together([value('user', 300), value('plan', 100)])
  assert.equal(both.kind, 'value')
  assert.deepEqual(both.value, ['user', 'plan'])
  assert.equal(both.at, 100) // the summary is dated by its stalest part
})

test('together: a record keeps its names', () => {
  const both = together({ user: value('u', 10), plan: value('p', 20) })
  assert.deepEqual(both.value, { user: 'u', plan: 'p' })
})

test('together: one part in flight keeps the whole in flight, held and showing', () => {
  const both = together([flight(value('user', 300), 70), value('plan', 100)])
  assert.equal(both.kind, 'loading')
  assert.equal(both.loading, true)
  assert.deepEqual(both.value, ['user', 'plan']) // stale shows while the fresh travels
  assert.equal(both.at, 100)
  assert.equal(both.kind === 'loading' && both.since, 70)
})

test('together: the first refusal in declaration order speaks for the whole', () => {
  const both = together([
    value('user', 10),
    no(value('plan', 20), 'plan gone'),
    no(EMPTY as Remote<string>, 'later trouble'),
  ])
  assert.equal(both.kind, 'failed')
  assert.match(String(both.error), /plan gone/)
  assert.deepEqual(heldOf(both), undefined) // one part holds nothing: no tuple to show
})

test('together: a refusal with everything still held keeps showing the whole', () => {
  const both = together([value('user', 10), no(value('plan', 20), 'refresh refused')])
  assert.equal(both.kind, 'failed')
  assert.deepEqual(both.value, ['user', 'plan'])
})

test('together: an empty part makes the whole empty — unless somebody failed or flies', () => {
  const both = together([value('user', 10), EMPTY as Remote<string>])
  assert.equal(both.kind, 'empty')
})

test('firstOf: the first part that holds wins; order is priority, not a clock', () => {
  const winner = firstOf<string>(EMPTY, flight(value('cached', 10), 5), value('network', 99))
  assert.equal(heldOf(winner)?.value, 'cached') // it holds, so it outranks the later value
})

test('firstOf: among the empty-handed, hope outranks refusal', () => {
  const hoping = firstOf<string>(
    no(EMPTY as Remote<string>, 'down'),
    flight(EMPTY as Remote<string>, 5),
  )
  assert.equal(hoping.kind, 'loading')

  const done = firstOf<string>(no(EMPTY as Remote<string>, 'down'), EMPTY as Remote<string>)
  assert.equal(done.kind, 'failed')

  assert.equal(firstOf<string>().kind, 'empty')
})
