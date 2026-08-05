import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { port, derived, watch, subscribe, batch, untracked } from '#graph/graph/graph.ts'

describe('the cell graph', () => {
  test('formula reads its inputs without declaring them', () => {
    const a = port(2)
    const b = port(3)
    const sum = derived(() => a.get() + b.get())
    assert.equal(sum.peek(), 5)
    a.set(10)
    assert.equal(sum.peek(), 13)
  })

  test('lazy: a formula nobody reads is never run', () => {
    let runs = 0
    const a = port(1)
    derived(() => {
      runs++
      return a.get()
    })
    a.set(2)
    assert.equal(runs, 0)
  })

  test('equal result stops propagation', () => {
    const a = port(1)
    const parity = derived(() => a.get() % 2)
    let seen = 0
    const stop = subscribe(parity, () => seen++)
    a.set(3) // parity unchanged
    assert.equal(seen, 0)
    a.set(4) // parity changed
    assert.equal(seen, 1)
    stop()
  })

  test('diamond: one write, one downstream run', () => {
    const a = port(1)
    const left = derived(() => a.get() * 2)
    const right = derived(() => a.get() * 3)
    let runs = 0
    const total = derived(() => {
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
    const a = port(1)
    const double = derived(() => a.get() * 2)
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
    const useLeft = port(true)
    const left = port('L')
    const right = port('R')
    let runs = 0
    const pick = derived(() => {
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
    const a = port(1)
    const b = port(1)
    const sum = derived(() => a.get() + b.get())
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
    const source = port(1)
    const mirror = port(0)
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
    const a = port(1)
    let seen = 0
    const stop = subscribe(a, () => seen++)
    a.set(2)
    assert.equal(seen, 1)
    stop()
    a.set(3)
    assert.equal(seen, 1)
  })

  test('cycle is reported, not hung', () => {
    const a = port(1)
    const self: { c?: ReturnType<typeof derived<number>> } = {}
    self.c = derived(() => a.get() + (self.c ? self.c.get() : 0))
    assert.throws(() => self.c!.peek(), /cycle/)
  })

  test('custom equality gates by content', () => {
    const raw = port({ id: 1, title: 'a' })
    const view = derived(() => ({ ...raw.get() }), {
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
})
