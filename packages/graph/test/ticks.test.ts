// The waves: the red dot of a gated wave, the journal as full history, the
// replay as a time machine, and the promise that a detached probe costs
// nothing observable.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { batch, derived, port, subscribe, trace } from '#graph'
import { attachProbe } from '#graph'
import type { TickSummary } from '#graph'
import { journal } from '#graph'
import type { Port } from '#weft'

describe('waves and the journal', () => {
  test('the red dot: a wave dies on equality and the summary names the place', () => {
    const seen: TickSummary[] = []
    attachProbe({ tick: (summary: TickSummary) => seen.push(summary) })
    try {
      const raw = port(1, { name: 'raw' })
      const doubled = derived(() => raw.get() * 2, { name: 'doubled' })
      const tens = derived(() => Math.floor(doubled.get() / 10), { name: 'tens' })
      let woke = 0
      const stop = subscribe(tens, () => woke++)

      raw.set(2) // doubled 2→4, tens 0→0: the wave dies at `tens`
      const wave = seen.at(-1)
      assert.ok(wave !== undefined)
      assert.deepEqual(
        wave.writes.map(w => w.node),
        ['raw'],
      )
      assert.deepEqual(wave.gated, ['tens'])
      assert.equal(wave.woke, 0) // nobody below the red dot moved

      raw.set(6) // tens 0→1: the wave carries through
      const carried = seen.at(-1)
      assert.ok(carried !== undefined)
      assert.deepEqual(carried.gated, [])
      assert.equal(carried.woke, 1)
      assert.equal(woke, 1)
      stop()
    } finally {
      attachProbe(null)
    }
  })

  test('a batch is one wave with all its writes', () => {
    const seen: TickSummary[] = []
    attachProbe({ tick: (summary: TickSummary) => seen.push(summary) })
    try {
      const a = port(1, { name: 'a' })
      const b = port(1, { name: 'b' })
      const sum = derived(() => a.get() + b.get(), { name: 'sum' })
      const stop = subscribe(sum, () => {})
      seen.length = 0

      batch(() => {
        a.set(2)
        b.set(3)
      })
      assert.equal(seen.length, 1)
      assert.deepEqual(seen[0]?.writes.map(w => w.node).toSorted(), ['a', 'b'])
      assert.equal(seen[0]?.woke, 1) // one settled picture, one waking
      stop()
    } finally {
      attachProbe(null)
    }
  })

  test('the journal is the full history: a fresh graph replayed lands in the same place', () => {
    interface Board {
      price: Port<number>
      count: Port<number>
      total: ReturnType<typeof derived<number>>
      registry: Map<string, Port<number>>
    }
    const build = (): Board => {
      const price = port(0, { name: 'price' })
      const count = port(0, { name: 'count' })
      const total = derived(() => price.get() * count.get(), { name: 'total' })
      return {
        price,
        count,
        total,
        registry: new Map<string, Port<number>>([
          ['price', price],
          ['count', count],
        ]),
      }
    }

    const lived = build()
    const looking = subscribe(lived.total, () => {}) // watched: it computes inside the waves
    const book = journal()
    book.start()
    try {
      lived.price.set(5)
      lived.count.set(3)
      batch(() => {
        lived.price.set(7)
        lived.count.set(11)
      })
      lived.price.set(7) // not a change: no wave, nothing to remember
    } finally {
      book.stop()
      looking()
    }
    assert.equal(book.ticks().length, 3)
    assert.equal(lived.total.peek(), 77)

    const reborn = build()
    book.replay(node => reborn.registry.get(node) as Port<unknown> | undefined)
    assert.equal(reborn.total.peek(), 77) // inputs are the whole entropy

    const why = book.why('total')
    assert.ok(why !== undefined)
    assert.deepEqual(why.writes.map(w => w.node).toSorted(), ['count', 'price']) // the wave that last touched it, triggers included
  })

  test('a detached probe reports nothing and changes nothing', () => {
    const seen: TickSummary[] = []
    attachProbe({ tick: (summary: TickSummary) => seen.push(summary) })
    attachProbe(null)
    const raw = port(1, { name: 'raw' })
    const twice = derived(() => raw.get() * 2, { name: 'twice' })
    const stop = subscribe(twice, () => {})
    raw.set(21)
    assert.equal(twice.peek(), 42)
    assert.equal(seen.length, 0)
    stop()
  })

  test('trace looks without touching: value, reads, readers, honest staleness', () => {
    const raw = port(2, { name: 'raw' })
    const twice = derived(() => raw.get() * 2, { name: 'twice' })
    const stop = subscribe(twice, () => {})

    raw.set(3)
    const look = trace(twice)
    assert.equal(look.name, 'twice')
    assert.equal(look.value, 6)
    assert.equal(look.state, 'clean')
    assert.deepEqual(
      look.reads?.map(r => r.name),
      ['raw'],
    )
    assert.deepEqual(look.readBy, ['(watcher)'])

    stop()
    const idle = trace(raw)
    assert.equal(idle.kind, 'input')
    assert.equal(idle.value, 3)
  })
})
