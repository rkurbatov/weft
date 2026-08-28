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
    // Red under: a ledger and an answer of the settling's own — and, for the
    // second half of it, throwing away the queue once anything has fallen.
    const app = graph('combined-errors')
    const trail: string[] = []
    const changed = app.port(false)
    const held = app.port(0, {
      onIdle: () => {
        trail.push('idle ran')
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
    assert.deepEqual(trail, ['idle ran'], 'and the hook had its turn rather than being dropped')
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

  test('a failure raised by the handler own work belongs to the same round', () => {
    // Answering for a failure can write, a write settles, and a settling can
    // fall. That failure is this round's too — waiting for some unrelated push
    // to carry it out is the same thing the queue used to do with its tail.
    //
    // Red under: ending the round on an empty queue without looking at what
    // has fallen since.
    const heard: string[] = []
    let writeFromHandler: (() => void) | undefined
    const app = graph('handler-settling', {
      onError: error => {
        const message = (error as Error).message
        heard.push(message)
        if (message === 'first') writeFromHandler?.()
      },
    })
    const trigger = app.port(false)
    writeFromHandler = () => trigger.set(true)
    app.watch(() => {
      if (trigger.get()) throw new Error('second')
    })
    const falling = app.port(0, {
      onIdle: () => {
        throw new Error('first')
      },
    })
    const stop = app.watch(() => falling.get())
    stop()
    assert.deepEqual(heard, ['first', 'second'])
    app.dispose()
  })

  test('a loop is a failure of its round, not a door of its own', () => {
    // Suspicion of a loop used to be thrown from inside the settling, which
    // took it past whoever was listening and into a flight the next falling
    // hook replaced. It stops the spinning either way; where it goes afterwards
    // is the round's business, like everything else that falls.
    //
    // Red under: throwing the suspicion from the settling instead of putting it
    // in the ledger.
    const app = graph('loop-and-hook')
    const gate = app.port(false)
    const held = app.port(0, {
      onIdle: () => {
        throw new Error('idle later')
      },
    })
    const ping = app.port(0)
    const pong = app.port(0)
    app.watch(() => {
      if (gate.get()) pong.set(ping.get() + 1)
      else held.get()
    })
    app.watch(() => {
      ping.set(pong.get() + 1)
    })
    let thrown: unknown
    try {
      gate.set(true)
    } catch (error) {
      thrown = error
    }
    assert.match(String(thrown), /has woken/, 'the later hook did not take its place')
    app.dispose()
  })

  test('with a handler, a loop is heard there and not thrown past it', () => {
    // The other side of the same law: one border for the round, so nothing
    // arrives at whoever happened to make the write while the handler hears
    // something else.
    //
    // Red under: throwing the suspicion from the settling instead of putting it
    // in the ledger.
    const heard: string[] = []
    const app = graph('loop-heard', {
      onError: error => heard.push(String((error as Error).message)),
    })
    const gate = app.port(false)
    const held = app.port(0, {
      onIdle: () => {
        throw new Error('idle later')
      },
    })
    const ping = app.port(0)
    const pong = app.port(0)
    app.watch(() => {
      if (gate.get()) pong.set(ping.get() + 1)
      else held.get()
    })
    app.watch(() => {
      ping.set(pong.get() + 1)
    })
    gate.set(true) // and nothing is thrown at the writer
    assert.equal(heard.length, 2)
    assert.match(heard[0] ?? '', /has woken/)
    assert.equal(heard[1], 'idle later')
    app.dispose()
  })

  test('a loop stands its own watcher down, not the work beside it', () => {
    // Suspicion falls in the middle of a front that already holds ordinary
    // consumers, and by then they are out of `pending`: stopping the settling
    // outright loses their update for good, because nothing will queue them
    // again. Standing the suspect down is all the stopping a loop needs — a
    // watcher that writes nothing cannot keep one turning — and the next write
    // starts its count afresh.
    //
    // Red under: stopping the whole settling at the first suspicion.
    const app = graph('loop-front')
    const gate = app.port(false)
    const left = app.port(0)
    const right = app.port(0)
    const tail = app.port(0)
    const carried = app.port(0)
    let runs = 0
    app.watch(() => {
      if (gate.get()) left.set(right.get() + 1)
    })
    app.watch(() => {
      if (!gate.get()) return
      right.set(left.get() + 1)
      runs++
      // From inside the loop and different every time, so an innocent consumer
      // stands in every front the loop makes — the one the suspicion falls in
      // among them, whatever the threshold happens to be.
      tail.set(runs)
    })
    app.watch(() => {
      carried.set(tail.get())
    })
    assert.throws(() => gate.set(true), /has woken/)
    assert.ok(tail.peek() > 0, 'the loop did turn, so there was work to carry')
    assert.equal(carried.peek(), tail.peek(), 'the write beside the loop was carried through')
    app.dispose()
  })

  test('a passenger is not stood down for a loop it only watches', () => {
    // Woken as often as the writers, and by them — a watcher that only reads
    // reaches any threshold just as fast, and it was named first here because
    // it was made first. Standing it down silences a reader and slows the
    // storm by nothing, since it produces no work to slow.
    //
    // Red under: standing down whoever is woken too often, without asking
    // whether its own turns made any work.
    const heard: string[] = []
    const app = graph('loop-passenger', {
      onError: error => heard.push((error as Error).message),
    })
    const gate = app.port(false)
    const left = app.port(0)
    const right = app.port(0)
    let seen = 0
    app.watch(() => {
      if (gate.get()) seen = left.get() // made first, and reads only
    })
    app.watch(() => {
      if (gate.get()) right.set(left.get() + 1)
    })
    app.watch(() => {
      if (gate.get()) left.set(right.get() + 1)
    })
    gate.set(true)
    assert.equal(heard.length, 1, 'one of the two writers, and not the reader')
    assert.equal(seen, left.peek(), 'and the reader had its turn once the loop broke')
    app.dispose()
  })

  test('a reader pulling a cell that has moved is a passenger too', () => {
    // Pulling queues work as well: the cell is found stale, it recomputes, and
    // whoever reads it is marked. None of that is the reader's doing — the
    // write that moved the cell was somebody else's turn. Counting "somebody
    // was queued while this watcher was on the stack" called the reader a
    // writer; counting what a write queues does not.
    //
    // Red under: counting anything queued during a turn rather than what that
    // turn's writes queued.
    const heard: string[] = []
    const app = graph('derived-passenger', {
      onError: error => heard.push((error as Error).message),
    })
    const gate = app.port(false)
    const left = app.port(0)
    const right = app.port(0)
    const view = app.derived(() => left.get() * 2)
    let seen = 0
    app.watch(() => {
      if (gate.get()) seen = view.get() // made first, and reads only
    })
    app.watch(() => {
      if (gate.get()) right.set(left.get() + 1)
    })
    app.watch(() => {
      if (gate.get()) left.set(right.get() + 1)
    })
    gate.set(true)
    assert.equal(heard.length, 1)
    assert.equal(seen, left.peek() * 2, 'and the reader ends on the final value')
    app.dispose()
  })

  test('one early write does not answer for a storm a hundred turns later', () => {
    // Evidence of writing belongs to the turn that wrote. Kept for the whole
    // settling it turns a watcher that wrote once — a first load, a diagnostic
    // — into a permissible casualty at the moment its write has nothing to do
    // with anything.
    //
    // Red under: keeping the evidence for the settling instead of spending it
    // at each turn.
    const heard: string[] = []
    const app = graph('former-writer', {
      onError: error => heard.push((error as Error).message),
    })
    const gate = app.port(false)
    const left = app.port(0)
    const right = app.port(0)
    const side = app.port(0)
    let seen = 0
    let wrote = false
    app.watch(() => {
      if (!gate.get()) return
      seen = left.get()
      if (!wrote) {
        wrote = true
        side.set(1) // once, early, and bounded
      }
    })
    app.watch(() => side.get()) // so that the one write really does wake somebody
    app.watch(() => {
      if (gate.get()) right.set(left.get() + 1)
    })
    app.watch(() => {
      if (gate.get()) left.set(right.get() + 1)
    })
    gate.set(true)
    assert.equal(heard.length, 1)
    assert.equal(seen, left.peek())
    app.dispose()
  })

  test('what the guard learned is not held past the settling it learned it in', () => {
    // The evidence is watchers, and a watcher holds its body, its region and
    // everything either closed over. Holding the last productive front until
    // some later write happens to clear it keeps all of that alive through any
    // amount of quiet — and through the engine's own death.
    //
    // Red under: emptying it at the next settling's door instead of at the end
    // of this one.
    const app = graph('worked-retention')
    const trigger = app.port(false)
    const target = app.port(0)
    const stopReader = app.watch(() => target.get())
    const stopWriter = app.watch(() => {
      if (trigger.get()) target.set(1)
    })
    trigger.set(true)
    stopWriter()
    stopReader()
    const held = (app.core as unknown as { worked?: Set<unknown> }).worked
    assert.equal(app.core.watching, 0)
    assert.equal(held?.size ?? 0, 0)
    app.dispose()
  })
})
