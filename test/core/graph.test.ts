import { test } from 'node:test'
import assert from 'node:assert/strict'
import { input, cell, watch, subscribe, batch, untracked } from '#core/graph.ts'

test('formula reads its inputs without declaring them', () => {
  const a = input(2)
  const b = input(3)
  const sum = cell(() => a.get() + b.get())
  assert.equal(sum.peek(), 5)
  a.set(10)
  assert.equal(sum.peek(), 13)
})

test('lazy: a formula nobody reads is never run', () => {
  let runs = 0
  const a = input(1)
  cell(() => {
    runs++
    return a.get()
  })
  a.set(2)
  assert.equal(runs, 0)
})

test('equal result stops propagation', () => {
  const a = input(1)
  const parity = cell(() => a.get() % 2)
  let seen = 0
  const stop = subscribe(parity, () => seen++)
  a.set(3) // parity unchanged
  assert.equal(seen, 0)
  a.set(4) // parity changed
  assert.equal(seen, 1)
  stop()
})

test('diamond: one write, one downstream run', () => {
  const a = input(1)
  const left = cell(() => a.get() * 2)
  const right = cell(() => a.get() * 3)
  let runs = 0
  const total = cell(() => {
    runs++
    return left.get() + right.get()
  })
  const stop = subscribe(total, () => {})
  assert.equal(total.peek(), 5)
  assert.equal(runs, 1)
  a.set(2)
  assert.equal(total.peek(), 10)
  assert.equal(runs, 2)
  stop()
})

test('no glitches: downstream never sees a half-updated picture', () => {
  const a = input(1)
  const double = cell(() => a.get() * 2)
  const seen: string[] = []
  const stop = watch(() => {
    seen.push(`${a.get()}:${double.get()}`)
  })
  a.set(2)
  a.set(3)
  assert.deepEqual(seen, ['1:2', '2:4', '3:6'])
  stop()
})

test('dependencies are dynamic: the untaken branch is not a dependency', () => {
  const useLeft = input(true)
  const left = input('L')
  const right = input('R')
  let runs = 0
  const pick = cell(() => {
    runs++
    return useLeft.get() ? left.get() : right.get()
  })
  const stop = subscribe(pick, () => {})
  assert.equal(pick.peek(), 'L')
  assert.equal(runs, 1)
  right.set('R2') // not read on this branch
  assert.equal(runs, 1)
  left.set('L2')
  assert.equal(pick.peek(), 'L2')
  assert.equal(runs, 2)
  stop()
})

test('batch: writers settle before watchers run', () => {
  const a = input(1)
  const b = input(1)
  const sum = cell(() => a.get() + b.get())
  const seen: number[] = []
  const stop = subscribe(sum, v => seen.push(v))
  batch(() => {
    a.set(10)
    b.set(10)
  })
  assert.deepEqual(seen, [20])
  stop()
})

test('watcher writing a cell settles in the same round', () => {
  const source = input(1)
  const mirror = input(0)
  const stop = watch(() => {
    const v = source.get()
    untracked(() => mirror.set(v * 10))
  })
  assert.equal(mirror.peek(), 10)
  source.set(4)
  assert.equal(mirror.peek(), 40)
  stop()
})

test('dispose stops the watcher', () => {
  const a = input(1)
  let seen = 0
  const stop = subscribe(a, () => seen++)
  a.set(2)
  assert.equal(seen, 1)
  stop()
  a.set(3)
  assert.equal(seen, 1)
})

test('cycle is reported, not hung', () => {
  const a = input(1)
  const self: { c?: ReturnType<typeof cell<number>> } = {}
  self.c = cell(() => a.get() + (self.c ? self.c.get() : 0))
  assert.throws(() => self.c!.peek(), /cycle/)
})

test('custom equality gates by content', () => {
  const raw = input({ id: 1, title: 'a' })
  const view = cell(() => ({ ...raw.get() }), {
    equal: (x, y) => x.id === y.id && x.title === y.title,
  })
  let seen = 0
  const stop = subscribe(view, () => seen++)
  raw.set({ id: 1, title: 'a' }) // same content, new object
  assert.equal(seen, 0)
  raw.set({ id: 1, title: 'b' })
  assert.equal(seen, 1)
  stop()
})
