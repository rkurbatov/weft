// The graph counting itself.
//
// Ordered by Retex (item 9): an orchestrator needs to see what recomputed and
// why. Ordinary cells, so a panel reads them like anything else — and off by
// default, because a counter nobody reads is work nobody asked for.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { batch, counters, derived, graph, port, subscribe, watch } from '#graph'
import { until } from '#testkit'

describe('counters over the graph', () => {
  test('ticks, recomputes and wakings are counted', () => {
    const seats = port(1, { name: 'seats' })
    const double = derived(() => seats.get() * 2, { name: 'double' })
    until(subscribe(double, () => {}))

    const count = counters()
    until(count.stop)

    seats.set(2)
    seats.set(3)

    assert.equal(count.ticks.peek(), 2, 'two settlings')
    assert.equal(count.computed.peek(), 2, 'the formula ran once per write')
    assert.equal(count.woken.peek(), 2, 'and the watcher woke twice')
  })

  test('a batch is one tick, whatever it holds', () => {
    const cells = Array.from({ length: 50 }, (_, i) => port(i, { name: `n${String(i)}` }))
    const total = derived(() => cells.reduce((sum, one) => sum + one.get(), 0), { name: 'total' })
    until(subscribe(total, () => {}))

    const count = counters()
    until(count.stop)

    batch(() => {
      for (const [i, one] of cells.entries()) one.set(i * 2)
    })

    assert.equal(count.ticks.peek(), 1, 'fifty writes, one settling')
    assert.equal(count.computed.peek(), 1, 'and one recompute')
  })

  test('a recompute that changes nothing is counted as gated', () => {
    const seats = port(1, { name: 'seats' })
    const parity = derived(() => seats.get() % 2, { name: 'parity' })
    until(subscribe(parity, () => {}))

    const count = counters()
    until(count.stop)

    seats.set(3) // parity unchanged: the tick dies here
    assert.equal(count.gated.peek(), 1)
    assert.equal(count.woken.peek(), 0, 'nobody below was woken')
  })

  test('a failure is counted, not swallowed', () => {
    // The failure is a state of the cell and is also thrown after the round;
    // both are true, and what is checked here is that it was counted.
    const engine = graph('failing', { onError: () => {} })
    until(() => engine.dispose())

    engine.build(() => {
      const seats = port(1, { name: 'seats' })
      const bad = derived(
        () => {
          if (seats.get() > 1) throw new Error('no')
          return seats.get()
        },
        { name: 'bad' },
      )
      until(subscribe(bad, () => {}))

      const count = counters(engine)
      until(count.stop)

      seats.set(2)
      // Two: the formula that threw, and the watcher that read it and got the
      // failure in turn. Both are places where the tick broke, and naming both
      // is the point of counting them.
      assert.equal(count.failed.peek(), 2)
    })
  })

  test('watchers alive are counted, and the queue is at its deepest', () => {
    const seats = port(1, { name: 'seats' })
    const count = counters()
    until(count.stop)

    const stops = [1, 2, 3].map(() => watch(() => seats.get()))
    seats.set(2)
    assert.equal(count.watching.peek(), 3, 'three screens')

    for (const stop of stops) stop()
    seats.set(3)
    assert.equal(count.watching.peek(), 0)
  })

  test('the counters are cells: a formula may depend on one', () => {
    const seats = port(1, { name: 'seats' })
    until(
      subscribe(
        derived(() => seats.get()),
        () => {},
      ),
    )
    const count = counters()
    until(count.stop)

    const busy = derived(() => count.ticks.get() > 1, { name: 'busy' })
    until(subscribe(busy, () => {}))
    assert.equal(busy.peek(), false)

    seats.set(2)
    seats.set(3)
    assert.equal(busy.peek(), true)
  })

  test('counting one graph does not count another', () => {
    const here = port(1, { name: 'here' })
    until(
      subscribe(
        derived(() => here.get()),
        () => {},
      ),
    )
    const count = counters()
    until(count.stop)

    const other = graph('other')
    until(() => other.dispose())
    other.build(() => {
      const there = port(1, { name: 'there' })
      subscribe(
        derived(() => there.get()),
        () => {},
      )
      there.set(2)
      there.set(3)
    })

    assert.equal(count.ticks.peek(), 0, 'the other engine settles on its own')
    here.set(2)
    assert.equal(count.ticks.peek(), 1)
  })

  test('stopping costs nothing afterwards', () => {
    const seats = port(1, { name: 'seats' })
    until(
      subscribe(
        derived(() => seats.get()),
        () => {},
      ),
    )
    const count = counters()
    seats.set(2)
    const settled = count.ticks.peek()

    count.stop()
    seats.set(3)
    seats.set(4)
    assert.equal(count.ticks.peek(), settled, 'nothing is counted once the probe is gone')
  })
})
