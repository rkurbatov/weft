// Acceptance test for the engine stage: two sessions living in one isolate.
//
// This is the requirement in the words of the problem. A leading tab or a
// shared worker serves several logged-in users at once; today the graph is
// module state, so those users share one propagation queue, one batch depth,
// and one lifetime. After this stage an engine is a value: every node knows
// its owner from birth, a region is a resident of an engine rather than a
// second owner of life, and reading across engines is a named error rather
// than a silent stitch.
//
// Written before the implementation on purpose: it is the contract for the
// surface, not a check of it.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { graph, port, subscribe } from '#weft'
import type * as Weft from '#weft'

describe('engines', () => {
  test('two engines propagate independently', () => {
    const a = graph('session-a')
    const b = graph('session-b')

    const seatsA = a.port(1)
    const seatsB = b.port(1)
    const doubleA = a.derived(() => seatsA.get() * 2)
    const doubleB = b.derived(() => seatsB.get() * 2)

    let wokeA = 0
    let wokeB = 0
    a.watch(() => {
      doubleA.get()
      wokeA++
    })
    b.watch(() => {
      doubleB.get()
      wokeB++
    })
    wokeA = 0
    wokeB = 0

    // A batch is a property of one engine: the other is not held back by it,
    // and its watchers are not woken by it.
    a.batch(() => {
      seatsA.set(2)
      seatsA.set(3)
    })
    assert.equal(wokeA, 1)
    assert.equal(wokeB, 0)
    assert.equal(doubleB.peek(), 2)

    b.batch(() => {
      seatsB.set(5)
    })
    assert.equal(wokeA, 1)
    assert.equal(wokeB, 1)

    a.dispose()
    b.dispose()
  })

  test('the same names in two engines are two nodes', () => {
    const a = graph('session-a')
    const b = graph('session-b')

    const userA = a.port('ann', { name: 'user' })
    const userB = b.port('bob', { name: 'user' })

    // Names exist for people reading a trace, not as keys. Two engines may hold
    // the same application built twice, so the same name is expected, and the
    // engine name is what tells them apart.
    assert.equal(userA.name, 'user')
    assert.equal(userB.name, 'user')
    assert.equal(userA.engine.name, 'session-a')
    assert.equal(userB.engine.name, 'session-b')
    assert.notEqual(userA.peek(), userB.peek())

    a.dispose()
    b.dispose()
  })

  test('disposing an engine takes down everything born in it, and nothing else', () => {
    const a = graph('session-a')
    const b = graph('session-b')

    const seatsA = a.port(1)
    const seatsB = b.port(1)
    let wokeA = 0
    let wokeB = 0
    let idleA = 0

    const held = a.port(0, { onIdle: () => idleA++ })
    a.watch(() => {
      held.get()
      seatsA.get()
      wokeA++
    })
    b.watch(() => {
      seatsB.get()
      wokeB++
    })

    a.dispose()

    // Watchers are gone, so demand is given back — an adapter learns to stop.
    assert.equal(idleA, 1)
    seatsA.set(2)
    assert.equal(wokeA, 1)

    // The neighbour is untouched.
    seatsB.set(2)
    assert.equal(wokeB, 2)

    b.dispose()
  })

  test('a region is a resident of its engine', () => {
    const a = graph('session-a')
    let woke = 0

    const region = a.region('kanban', () => {
      const cards = a.port(0)
      a.watch(() => {
        cards.get()
        woke++
      })
      return cards
    })

    // The region prefixes names within its engine, and lets its own piece go
    // without touching the rest of the engine.
    assert.equal(region.value.name, 'kanban.input')
    const outside = a.port(0)
    let outsideWoke = 0
    a.watch(() => {
      outside.get()
      outsideWoke++
    })

    region.dispose()
    region.value.set(1)
    assert.equal(woke, 1)
    outside.set(1)
    assert.equal(outsideWoke, 2)

    // And the engine takes down the regions it holds.
    const second = graph('session-b')
    const region2 = second.region('kanban', () => second.port(0))
    second.dispose()
    assert.equal(region2.disposed, true)

    a.dispose()
  })

  test('an adopted value carries demand across, and only while somebody looks', () => {
    const common = graph('common')
    const ann = graph('session-ann')
    const asked: string[] = []
    const rates = common.port(
      { eur: 2 },
      { onDemand: () => asked.push('on'), onIdle: () => asked.push('off') },
    )

    const here = ann.adopt(rates)
    assert.deepEqual(asked, [], 'adopting is not looking')

    const stop = ann.watch(() => {
      here.get()
    })
    assert.deepEqual(asked, ['on'], 'a look here wakes the shared engine there')

    stop()
    assert.deepEqual(asked, ['on', 'off'], 'and lets it rest again')

    ann.dispose()
    common.dispose()
  })

  test('reading across engines is a named error', () => {
    const a = graph('session-a')
    const b = graph('session-b')

    const seatsB = b.port(1)
    const crossing = a.derived(() => seatsB.get() * 2)

    assert.throws(
      () => crossing.get(),
      // Both engines are named: the message must say where the reader lives and
      // where the thing it reached for lives.
      /session-a.*session-b/s,
    )

    a.dispose()
    b.dispose()
  })

  test('the bare functions stay, and go quiet when a second engine exists', () => {
    // Ordinary single-graph applications never learn that engines exist: the
    // module-level functions build in the root engine, exactly as before.
    const seats = port(1)
    let woke = 0
    const stop = subscribe(seats, () => woke++)
    seats.set(2)
    assert.equal(woke, 1)
    stop()

    // The moment a second engine is alive in this isolate, building without
    // saying where is ambiguous — and ambiguity here means one user's cell in
    // another user's graph. Loud, not silent.
    const other = graph('session-b')
    assert.throws(() => port(0), /engine/)
    other.dispose()

    // With the second engine gone the ambiguity is gone with it.
    assert.doesNotThrow(() => port(0))
  })

  test('two applications share an isolate with no root engine between them', async () => {
    // A widget embedded in someone else's page: there is no "the" graph, each
    // application builds its own. Nodes are recognised by mark, not by class —
    // a bundler is free to leave two copies of the library on the page, and
    // `instanceof` across copies is false.
    // The path is held in a variable on purpose: the query string is what makes
    // the loader hand back a second, separate copy of the library.
    const secondCopy = '../../../../packages/weft/src/index.ts?copy=2'
    const other = (await import(secondCopy)) as typeof Weft

    const mine = graph('checkout')
    const theirs = other.graph('host-page')

    const price = mine.port(10)
    const stock = theirs.port(3)

    let woke = 0
    mine.watch(() => {
      price.get()
      woke++
    })

    // The foreign engine holds a foreign class; the graph must still know a node
    // when it sees one, and must still refuse to be read across the border.
    assert.throws(() => mine.derived(() => stock.get()).get(), /checkout.*host-page/s)
    stock.set(4)
    assert.equal(woke, 1)

    mine.dispose()
    theirs.dispose()
  })

  test('one tab, two sessions in a row, nothing left ticking', () => {
    let idle = 0
    const first = graph('session-ann')
    const seats = first.port(1, { onIdle: () => idle++ })
    first.watch(() => seats.get())

    // Logging out and back in as someone else: the whole household goes, and the
    // next session starts from nothing rather than from the previous tenant.
    first.dispose()
    assert.equal(idle, 1)

    const second = graph('session-bob')
    const seatsAgain = second.port(1)
    let woke = 0
    second.watch(() => {
      seatsAgain.get()
      woke++
    })
    seats.set(2)
    assert.equal(woke, 1)
    seatsAgain.set(2)
    assert.equal(woke, 2)
  })

  test('data belonging to nobody lives in a shared engine and is adopted', () => {
    // Reference tables, flags, theme: duplicating them per session is waste,
    // and reading them across the border is exactly what the border forbids.
    // The shared engine publishes; sessions adopt — read, never write, declared
    // at build time and visible in a trace.
    const common = graph('common')
    const rates = common.port({ eur: 2 })

    const ann = graph('session-ann')
    const bob = graph('session-bob')
    const ratesForAnn = ann.adopt(rates)
    const ratesForBob = bob.adopt(rates)

    const priced = ann.derived(() => ratesForAnn.get().eur * 100)
    let bobSaw = 0
    bob.watch(() => {
      ratesForBob.get()
      bobSaw++
    })

    assert.equal(priced.peek(), 200)
    common.batch(() => rates.set({ eur: 3 }))
    assert.equal(priced.get(), 300)
    assert.equal(bobSaw, 2)

    // Adopted is readable, not writable: a session cannot rewrite common truth.
    assert.equal('set' in ratesForAnn, false)

    // And the border still stands for everything not adopted.
    const secret = common.port('x')
    assert.throws(() => ann.derived(() => secret.get()).get(), /session-ann.*common/s)

    ann.dispose()
    bob.dispose()
    common.dispose()
  })
})
