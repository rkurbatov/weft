// What the engine keeps, and for how long.
//
// Beside the code because it looks at the engine's own bookkeeping: the list
// of teardowns it holds. Through the public surface a leak here is invisible —
// everything works, the memory just never comes back — which is exactly why it
// went unnoticed until a review.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { graph } from '../src/graph.ts'
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
