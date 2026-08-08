// Handing a buffer over instead of copying it.
//
// Measured first: at ten sends a second, under a megabyte copying costs nothing
// worth naming, eight megabytes take four percent of the budget, thirty take
// nineteen. Handing over is almost free at any size — and empties the buffer on
// this side, which is why it is declared by the application and never decided
// by the library.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { MessageChannel } from 'node:worker_threads'
import { atOnce, handedOver, handOver, link, overWire, serve } from '#link'
import { heldOf, port, subscribe } from '#weft'
import { settle, setupWire, until } from '#testkit'

describe('declaring that a value may be handed over', () => {
  test('the wrapper says so about the value, not about the cell', () => {
    const numbers = new Float64Array([1, 2, 3])
    const given = handOver(numbers)

    assert.equal(handedOver(given), true)
    assert.equal(given.value, numbers, 'the value is carried as it is')
    assert.deepEqual(given.buffers, [numbers.buffer], 'and its buffer is named')

    // A plain value is not wrapped, and nothing pretends it is.
    assert.equal(handedOver(numbers), false)
    assert.equal(handedOver({ hist: numbers }), false)
  })

  test('buffers are found beside their labels, one level down', () => {
    const hist = new Float64Array([1, 2])
    const at = new Uint32Array([10, 20])
    const given = handOver({ hist, at, name: 'latency' })

    assert.equal(given.buffers.length, 2, 'both of them')
    assert.ok(given.buffers.includes(hist.buffer))
    assert.ok(given.buffers.includes(at.buffer))
  })

  test('the same buffer named twice is named once', () => {
    // Two views of one buffer is an ordinary thing to build, and a wire refuses
    // the same buffer twice.
    const bytes = new ArrayBuffer(16)
    const given = handOver({ first: new Float64Array(bytes, 0, 1), second: new Uint8Array(bytes) })
    assert.equal(given.buffers.length, 1)
  })

  test('a channel that cannot hand over copies, and is right to', async () => {
    const numbers = new Float64Array([1, 2, 3])
    const hist = port<unknown>(handOver(numbers), { name: 'hist' })

    const { watcher } = setupWire({ cells: { hist } })
    until(watcher.close)
    const mirror = watcher.derived<Float64Array>('hist')
    until(subscribe(mirror, () => {}))
    await settle(3)

    assert.deepEqual(
      [...(heldOf(mirror.peek())?.value ?? [])],
      [1, 2, 3],
      'the far side reads the value, wrapper and all gone',
    )
    // A pair of functions in memory has no ownership to give: the buffer is
    // still here, which is slower and never wrong.
    assert.equal(numbers.length, 3)
  })

  test('over a real port the buffer is given away, not copied', async () => {
    const { port1, port2 } = new MessageChannel()
    const numbers = new Float64Array([1, 2, 3, 4])
    const hist = port<unknown>(handOver(numbers), { name: 'hist' })

    const stop = serve({ cells: { hist } }, overWire(port1 as never), {
      schedule: atOnce,
    })
    const watcher = link(overWire(port2 as never))
    const mirror = watcher.derived<Float64Array>('hist')
    const off = subscribe(mirror, () => {})
    await settle(6)

    assert.deepEqual([...(heldOf(mirror.peek())?.value ?? [])], [1, 2, 3, 4], 'it arrived whole')
    // And it is gone from this side: that is what handing over means, and why
    // it has to be said out loud rather than guessed by size.
    assert.equal(numbers.length, 0, 'the buffer here is empty now')

    off()
    watcher.close()
    stop()
    port1.close()
    port2.close()
  })

  test('a value not declared is copied, and stays here', async () => {
    const { port1, port2 } = new MessageChannel()
    const numbers = new Float64Array([1, 2, 3, 4])
    const hist = port<unknown>(numbers, { name: 'hist' })

    const stop = serve({ cells: { hist } }, overWire(port1 as never), {
      schedule: atOnce,
    })
    const watcher = link(overWire(port2 as never))
    const mirror = watcher.derived<Float64Array>('hist')
    const off = subscribe(mirror, () => {})
    await settle(6)

    assert.deepEqual([...(heldOf(mirror.peek())?.value ?? [])], [1, 2, 3, 4])
    assert.equal(numbers.length, 4, 'nothing was taken away from this side')

    off()
    watcher.close()
    stop()
    port1.close()
    port2.close()
  })
})
