import { test } from 'node:test'
import assert from 'node:assert/strict'
import { input, cell, watch, subscribe, untracked } from '#graph/graph/graph.ts'
import { family } from '#graph/graph/family.ts'

function tracked() {
  const log: string[] = []
  const source = input(0, { onDemand: () => log.push('start'), onIdle: () => log.push('stop') })
  return { source, log }
}

test('demand appears with the first watcher and goes with the last', () => {
  const { source, log } = tracked()
  assert.deepEqual(log, [])
  const a = subscribe(source, () => {})
  const b = subscribe(source, () => {})
  assert.deepEqual(log, ['start'])
  assert.equal(source.demand, 2)
  a()
  assert.deepEqual(log, ['start'])
  b()
  assert.deepEqual(log, ['start', 'stop'])
  assert.equal(source.demand, 0)
})

test('reading without a watcher does not demand', () => {
  const { source, log } = tracked()
  source.peek()
  untracked(() => source.get())
  const derived = cell(() => source.get() * 2)
  derived.peek() // computed on request, nobody live behind it
  assert.deepEqual(log, [])
  assert.equal(source.demand, 0)
})

test('demand travels through a chain of formulas', () => {
  const { source, log } = tracked()
  const one = cell(() => source.get() + 1)
  const two = cell(() => one.get() + 1)
  const stop = subscribe(two, () => {})
  assert.deepEqual(log, ['start'])
  assert.equal(one.demanded, true)
  stop()
  assert.deepEqual(log, ['start', 'stop'])
  assert.equal(one.demanded, false)
})

test('a dependency dropped by a branch releases its source', () => {
  const useIt = input(true)
  const { source, log } = tracked()
  const pick = cell(() => (useIt.get() ? source.get() : -1))
  const stop = subscribe(pick, () => {})
  assert.deepEqual(log, ['start'])
  useIt.set(false)
  assert.deepEqual(log, ['start', 'stop'])
  useIt.set(true)
  assert.deepEqual(log, ['start', 'stop', 'start'])
  stop()
  assert.deepEqual(log, ['start', 'stop', 'start', 'stop'])
})

test('a surviving dependency is not restarted on recompute', () => {
  const other = input(0)
  const { source, log } = tracked()
  const both = cell(() => source.get() + other.get())
  const stop = subscribe(both, () => {})
  other.set(1)
  other.set(2)
  assert.deepEqual(log, ['start'])
  stop()
})

test('the hook may write its own cell: it runs outside the formula', () => {
  const store = input(0, {
    onDemand: () => {
      store.set(42)
    },
  })
  const seen: number[] = []
  const stop = watch(() => {
    seen.push(store.get())
  })
  assert.deepEqual(seen, [0, 42])
  stop()
})

test('family members carry demand to their sources', () => {
  const { source, log } = tracked()
  const item = family((id: string) => `${id}:${source.get()}`)
  item('a').peek()
  assert.deepEqual(log, [])
  const stop = subscribe(item('a'), () => {})
  assert.deepEqual(log, ['start'])
  stop()
  assert.deepEqual(log, ['start', 'stop'])
})

test('a watched member keeps its source while an unwatched sibling is swept', () => {
  const { source, log } = tracked()
  const item = family((id: string) => `${id}:${source.get()}`)
  const stop = subscribe(item('a'), () => {})
  item('b').peek()
  assert.equal(item.sweep(), 1)
  assert.deepEqual(log, ['start'])
  stop()
  assert.deepEqual(log, ['start', 'stop'])
})

test('demand counts paths, not readers', () => {
  const { source } = tracked()
  const left = cell(() => source.get())
  const right = cell(() => source.get())
  const stopL = subscribe(left, () => {})
  const stopR = subscribe(right, () => {})
  assert.equal(source.demand, 2)
  stopL()
  assert.equal(source.demand, 1)
  stopR()
  assert.equal(source.demand, 0)
})
