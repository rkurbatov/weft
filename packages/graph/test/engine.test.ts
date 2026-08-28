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

  test('a thrown notice does not lock later rounds out', () => {
    // Only that, and the name says only that: the flag that keeps the queue
    // from running twice at once has to come back down however a callback
    // ends. A stuck flag would have silenced every notice afterwards — no
    // eviction, no idle hook, no error, nothing. What happens to the notices
    // standing behind the one that threw is the next witness.
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

  test('a notice that throws does not strand the round behind it', () => {
    // The round is carried to its end and the failure comes after it, exactly
    // as a settling does with its watchers. Half a round left lying until some
    // unrelated push arrives is not a boundary anybody chose: the hooks behind
    // the one that fell are ordinary work, and one of them is the eviction that
    // keeps a ceiling.
    //
    // Red under: letting a callback's failure out of the loop instead of
    // collecting it.
    const app = graph('notice-errors')
    const order: string[] = []
    const first = app.port(0, {
      onIdle: () => {
        order.push('first')
        throw new Error('boom')
      },
    })
    const second = app.port(0, {
      onIdle: () => {
        order.push('second')
      },
    })
    const stop = app.watch(() => {
      first.get()
      second.get()
    })
    assert.throws(stop, /boom/, 'and the failure is not swallowed either')
    assert.deepEqual(order, ['first', 'second'])
    app.dispose()
  })

  test('with a handler, every notice runs and every failure is heard in order', () => {
    // The same border the settling uses: with somebody to tell, all of them are
    // told, and nothing is thrown at whoever happened to make the graph quiet.
    //
    // Red under: answering for only the first failure of the round.
    const heard: string[] = []
    const app = graph('notice-handler', {
      onError: error => heard.push((error as Error).message),
    })
    const order: string[] = []
    const first = app.port(0, {
      onIdle: () => {
        order.push('first')
        throw new Error('one')
      },
    })
    const second = app.port(0, {
      onIdle: () => {
        order.push('second')
        throw new Error('two')
      },
    })
    const stop = app.watch(() => {
      first.get()
      second.get()
    })
    stop()
    assert.deepEqual(order, ['first', 'second'])
    assert.deepEqual(heard, ['one', 'two'])
    app.dispose()
  })

  test('work put down by the error handler is done before the round ends', () => {
    // Answering for a failure is itself something that can queue a notice, and
    // the guard against nesting keeps it out of the handler. Somebody has to
    // come back for it, and that somebody is the round it belongs to.
    //
    // Red under: looking at the queue once rather than again after the failures
    // have been answered for.
    const trail: string[] = []
    let insideHandler = false
    const app = graph('notice-tail', {
      onError: () => {
        insideHandler = true
        app.core.notice(() => trail.push('put down by the handler'))
        trail.push('handler')
        insideHandler = false
      },
    })
    const falling = app.port(0, {
      onIdle: () => {
        trail.push('hook')
        throw new Error('boom')
      },
    })
    const stop = app.watch(() => falling.get())
    stop()
    assert.deepEqual(trail, ['hook', 'handler', 'put down by the handler'])
    assert.equal(insideHandler, false)
    app.dispose()
  })

  test('a failing hook does not hide the watcher that set it off', () => {
    // With nobody to tell, the first failure of the round is the one thrown.
    // The settling used to answer for its own the moment it ended, from a
    // `finally` that then went on to drain — so the hook's failure left by the
    // same door afterwards and replaced the one already in flight. Formally
    // thrown, never seen.
    //
    // Red under: a ledger and an answer of the settling's own.
    const app = graph('combined-errors')
    const changed = app.port(false)
    const held = app.port(0, {
      onIdle: () => {
        throw new Error('idle second')
      },
    })
    app.watch(() => {
      if (changed.get()) throw new Error('watcher first')
      held.get()
    })
    let failure: unknown
    try {
      changed.set(true)
    } catch (error) {
      failure = error
    }
    assert.match(String(failure), /watcher first/)
    app.dispose()
  })

  test('failures of a round are heard in the order they happened, wherever they fell', () => {
    // The mirror of it, with somebody to tell: a hook fails, a later hook
    // writes, that write settles and a watcher fails. Two sources, one round,
    // and the order is the round's — not one source's before the other's.
    //
    // Red under: a ledger and an answer of the settling's own.
    const heard: string[] = []
    const app = graph('cross-order', {
      onError: error => heard.push((error as Error).message),
    })
    const trigger = app.port(false)
    app.watch(() => {
      if (trigger.get()) throw new Error('watcher second')
    })
    const failing = app.port(0, {
      onIdle: () => {
        throw new Error('notice first')
      },
    })
    const writing = app.port(0, {
      onIdle: () => {
        trigger.set(true)
      },
    })
    const stop = app.watch(() => {
      failing.get()
      writing.get()
    })
    stop()
    assert.deepEqual(heard, ['notice first', 'watcher second'])
    app.dispose()
  })
})
