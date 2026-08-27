// What the engine keeps, and for how long.
//
// Beside the code because it looks at the engine's own bookkeeping: the list
// of teardowns it holds. Through the public surface a leak here is invisible —
// everything works, the memory just never comes back — which is exactly why it
// went unnoticed until a review.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { derived, graph, port, watch } from '../src/graph.ts'
import type { Core } from '../src/engine.ts'

/** The engine's own list of things to let go of. Not offered to anybody. */
const holdings = (core: Core): unknown[] => (core as unknown as { household: unknown[] }).household

describe('what the engine holds', () => {
  test('a region signs itself out when it goes', () => {
    const g = graph('app')
    const core = g.core

    const first = g.region('modal', () => g.port(1))
    assert.equal(holdings(core).length, 1)

    first.dispose()
    assert.equal(holdings(core).length, 0, 'a dead region is not kept')

    g.dispose()
  })

  test('a thousand modules raised and dropped leave nothing behind', () => {
    const g = graph('app')
    const core = g.core

    for (let i = 0; i < 1000; i++) {
      const module = g.region(`modal-${i}`, () => {
        const value = g.port(i)
        g.watch(() => {
          value.get()
        })
        return value
      })
      module.dispose()
    }

    // The whole point: this used to be 1000 dead closures in a long-lived app.
    assert.equal(holdings(core).length, 0)

    g.dispose()
  })

  test('a nested region signs itself out of the one around it', () => {
    const g = graph('app')
    const core = g.core

    g.region('page', () => {
      // Inside the build, the enclosing region is the current one — so its own
      // list can be watched while modules come and go within it.
      const page = core.currentRegion()
      assert.notEqual(page, null)
      const held = page?.teardowns ?? []

      for (let i = 0; i < 100; i++) {
        const panel = g.region(`panel-${i}`, () => g.port(i))
        panel.dispose()
      }
      assert.equal(held.length, 0, 'the page does not collect its dead panels')

      const standing = g.region('kept', () => g.port(0))
      assert.equal(held.length, 1, 'a living one is held')
      return standing
    })

    g.dispose()
  })
})

describe('the queue the engine runs when the graph is quiet', () => {
  test('a notice waits for the one already running to finish', () => {
    // A notice that lets a cell go disposes it, and disposing is a move of the
    // graph: it enters and leaves. Leaving used to drain the queue again, so
    // the next notice ran in the middle of the first one — with the graph
    // halfway through a release rather than quiet.
    //
    // Red under: dropping the guard on the drain.
    const inside: boolean[] = []
    let running = false
    const first = port(0, {
      onIdle: () => {
        running = true
        derived(() => 1).dispose() // a move of the graph, from inside a notice
        running = false
      },
    })
    const second = port(0, {
      onIdle: () => {
        inside.push(running)
      },
    })
    const stop = watch(() => {
      first.get()
      second.get()
    })
    stop()
    assert.deepEqual(inside, [false], 'the second notice ran, and not inside the first')
  })

  test('a notice put down by a notice waits for its turn', () => {
    // The other way in: not a move of the graph draining again, but a callback
    // queueing one itself. Same law, and the queue stays first in, first out.
    //
    // Red under: running a notice on the spot when one is already running.
    const app = graph('notice-order')
    const order: string[] = []
    app.core.notice(() => {
      order.push('first in')
      app.core.notice(() => order.push('second'))
      order.push('first out')
    })
    assert.deepEqual(order, ['first in', 'first out', 'second'])
    app.dispose()
  })

  test('a notice that throws does not jam the ones behind it', () => {
    // The queue is a piece of state, and the flag that keeps it from running
    // twice at once has to come back down however the callback ends. It threw
    // once in this library already, and a stuck flag would have silenced every
    // notice afterwards — no error, no eviction, no idle hook, nothing.
    //
    // Red under: lowering the flag after the loop instead of in a finally.
    const app = graph('notice-throw')
    assert.throws(
      () =>
        app.core.notice(() => {
          throw new Error('boom')
        }),
      /boom/,
    )
    let ran = false
    app.core.notice(() => {
      ran = true
    })
    assert.equal(ran, true, 'the queue runs again after one of them threw')
    app.dispose()
  })
})
