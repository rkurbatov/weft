import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { port, derived, subscribe } from '#graph'
import { family } from '#graph'

describe('families of cells', () => {
  test('same key gives the same cell, different keys different cells', () => {
    const table = port(new Map([['a', 1]]))
    const item = family((id: string) => table.get().get(id) ?? 0)
    assert.equal(item('a'), item('a'))
    assert.notEqual(item('a'), item('b'))
    assert.equal(item('a').peek(), 1)
    assert.equal(item('b').peek(), 0)
  })

  test('lazy: a member nobody asked for is never built', () => {
    let built = 0
    const item = family((id: string) => {
      built++
      return id.toUpperCase()
    })
    assert.equal(built, 0)
    assert.equal(item('x').peek(), 'X')
    assert.equal(built, 1)
    item('x').peek()
    assert.equal(built, 1)
  })

  test('a member reacts to its own row only', () => {
    const rows = port(
      new Map([
        ['a', 1],
        ['b', 1],
      ]),
    )
    let runs = 0
    const item = family((id: string) => {
      runs++
      return rows.get().get(id) ?? 0
    })
    const stopA = subscribe(item('a'), () => {})
    const stopB = subscribe(item('b'), () => {})
    runs = 0
    rows.set(
      new Map([
        ['a', 2],
        ['b', 1],
      ]),
    )
    assert.equal(item('a').peek(), 2)
    assert.equal(item('b').peek(), 1)
    // Both recompute — they read the whole map — but 'b' produced an equal value
    // and therefore did not wake its watcher.
    assert.equal(runs, 2)
    stopA()
    stopB()
  })

  test('watched members do not wake on unrelated writes', () => {
    const rows = port(
      new Map([
        ['a', 1],
        ['b', 1],
      ]),
    )
    const item = family((id: string) => rows.get().get(id) ?? 0)
    let wokeA = 0
    let wokeB = 0
    const stopA = subscribe(item('a'), () => wokeA++)
    const stopB = subscribe(item('b'), () => wokeB++)
    rows.set(
      new Map([
        ['a', 2],
        ['b', 1],
      ]),
    )
    assert.equal(wokeA, 1)
    assert.equal(wokeB, 0)
    stopA()
    stopB()
  })

  test('unwatched members are evicted past the ceiling, watched ones are kept', () => {
    const item = family((id: number) => id * 2, { max: 3 })
    const stop = subscribe(item(1), () => {})
    item(2)
    item(3)
    item(4)
    item(5)
    assert.equal(item(1).observed, true)
    assert.ok(item.size <= 4, `size ${item.size}`)
    assert.equal(item.has(1), true)
    stop()
  })

  test('eviction is refused while somebody watches', () => {
    const item = family((id: string) => id)
    const stop = subscribe(item('a'), () => {})
    assert.equal(item.evict('a'), false)
    stop()
    assert.equal(item.evict('a'), true)
    assert.equal(item.has('a'), false)
  })

  test('a rebuilt member computes again and is correct', () => {
    const source = port(1)
    let builds = 0
    const item = family((id: string) => {
      builds++
      return `${id}:${source.get()}`
    })
    assert.equal(item('a').peek(), 'a:1')
    assert.equal(builds, 1)
    assert.equal(item.evict('a'), true)
    source.set(2)
    assert.equal(item('a').peek(), 'a:2')
    assert.equal(builds, 2)
  })

  test('evicted member stops hearing its sources', () => {
    const source = port(1)
    let runs = 0
    const item = family((_id: string) => {
      runs++
      return source.get()
    })
    const member = item('a')
    member.peek()
    assert.equal(runs, 1)
    item.evict('a')
    source.set(2)
    member.peek() // rebuilt on demand, not driven by the write
    assert.equal(runs, 2)
  })

  test('sweep drops the unwatched and counts them', () => {
    const item = family((id: number) => id)
    const stop = subscribe(item(1), () => {})
    item(2)
    item(3)
    assert.equal(item.sweep(), 2)
    assert.equal(item.size, 1)
    assert.equal(item.has(1), true)
    stop()
  })

  test('a formula over a member depends on it', () => {
    const rows = port(new Map([['a', 2]]))
    const item = family((id: string) => rows.get().get(id) ?? 0)
    const doubled = derived(() => item('a').get() * 10)
    let seen = 0
    const stop = subscribe(doubled, () => seen++)
    assert.equal(doubled.peek(), 20)
    rows.set(new Map([['a', 3]]))
    assert.equal(doubled.peek(), 30)
    assert.equal(seen, 1)
    stop()
  })

  test('object keys need keyOf, and then behave like any other', () => {
    type At = { row: number; col: number }
    assert.throws(() => family((k: At) => k.row)({ row: 1, col: 1 }), /keyOf/)
    const at = family((k: At) => `${k.row}/${k.col}`, { keyOf: k => `${k.row}:${k.col}` })
    assert.equal(at({ row: 1, col: 2 }), at({ row: 1, col: 2 }))
    assert.equal(at({ row: 1, col: 2 }).peek(), '1/2')
    assert.equal(at.size, 1)
  })

  test('a watched member survives every drop path', () => {
    const item = family((id: number) => id, { max: 1 })
    const stop = subscribe(item(1), () => {})
    item(2)
    item(3)
    item.sweep()
    assert.equal(item.evict(1), false)
    assert.equal(item.has(1), true)
    assert.equal(item(1).observed, true)
    stop()
    assert.equal(item.evict(1), true)
  })
})
