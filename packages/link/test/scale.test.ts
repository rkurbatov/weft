// A batch at scale: hundreds of writes, one waking.
//
// The order from Retex (item 8) is not a new capability but a proof: editing a
// node of a tree rewrites a subtree, so hundreds of ports change at once and
// no watcher may see the halfway states or wake a hundred times. Written here
// rather than in the demo, so that the proof survives the demo.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { batch, derived, heldOf, port, subscribe, wirePair } from '#weft'
import { onNotice } from '#data'
import { atOnce, link, serve } from '#link'
import { settle, setupWire, track, until } from '#testkit'

describe('a batch at the scale a real edit has', () => {
  test('three hundred writes wake a watcher once, not three hundred times', () => {
    const nodes = Array.from({ length: 300 }, (_, i) => port(i, { name: `n${String(i)}` }))
    const total = derived(() => nodes.reduce((sum, node) => sum + node.get(), 0))

    let wakings = 0
    const seen: number[] = []
    until(
      subscribe(total, value => {
        wakings++
        seen.push(value)
      }),
    )

    const before = wakings
    batch(() => {
      for (const [i, node] of nodes.entries()) node.set(i * 2)
    })

    assert.equal(wakings - before, 1, 'one waking for the whole edit')
    assert.equal(seen.at(-1), 300 * 299, 'and it carries the finished state')
  })

  test('nothing halfway is visible from inside the batch either', () => {
    const left = port(1)
    const right = port(1)
    // The invariant a subtree edit has: the two move together, and a watcher
    // that sees them apart would be seeing a state that never existed.
    const sum = derived(() => left.get() + right.get())
    const seen = track(sum)

    batch(() => {
      left.set(10)
      assert.equal(sum.peek(), 11, 'read inside the batch sees the write that happened')
      right.set(10)
    })

    // A subscription reports changes, not the value it started with: what a
    // watcher saw here is one state, the finished one.
    seen.said([20])
  })

  test('through the wire, the same edit is one message', async () => {
    const nodes = Array.from({ length: 300 }, (_, i) => port(i, { name: `n${String(i)}` }))
    const total = derived(() => nodes.reduce((sum, node) => sum + node.get(), 0))

    const wire = wirePair()
    let sent = 0
    until(
      serve({ cells: { total } }, wire.graph, {
        schedule: work => {
          sent++
          work()
        },
      }),
    )

    const watcher = link(wire.watcher)
    until(watcher.close)
    const mirror = watcher.derived<number>('total')
    let landed = 0
    until(
      subscribe(mirror, () => {
        landed++
      }),
    )
    await settle(3)

    const sentBefore = sent
    const landedBefore = landed
    batch(() => {
      for (const [i, node] of nodes.entries()) node.set(i * 3)
    })
    await settle(3)

    assert.equal(sent - sentBefore, 1, 'one flush for three hundred writes')
    assert.equal(landed - landedBefore, 1, 'and one waking on the far side')
  })

  test('and a slow reader is told what is true now, not what was', async () => {
    const seats = port(0, { name: 'seats' })
    const wire = wirePair()
    // A schedule that only runs when told: the flushes pile up as a real slow
    // reader's would.
    let run: (() => void) | undefined
    until(
      serve({ cells: { seats } }, wire.graph, {
        schedule: work => {
          run = work
        },
      }),
    )

    const watcher = link(wire.watcher)
    until(watcher.close)
    const mirror = watcher.derived<number>('seats')
    const seen: unknown[] = []
    until(subscribe(mirror, value => seen.push(value)))
    run?.()
    await settle(3)

    for (let i = 1; i <= 50; i++) seats.set(i)
    run?.()
    await settle(3)

    const last = seen.at(-1)
    assert.equal(
      (last as { value?: number } | undefined)?.value ?? undefined,
      50,
      'the fiftieth value, not a history of forty-nine others',
    )
  })
})

describe('the engine works while it is watched, and only then', () => {
  test('demand crossing the wire starts the work, and its leaving stops it', async () => {
    let ticks = 0
    // A stand-in for Retex's engine: it does its work while somebody looks.
    const beat = port(0, { name: 'beat', onDemand: () => ticks++, onIdle: () => ticks-- })

    const { watcher } = setupWire({ cells: { beat } })
    until(watcher.close)

    assert.equal(ticks, 0, 'nobody is looking yet, on either side')

    const stop = subscribe(watcher.derived<number>('beat'), () => {})
    await settle(3)
    assert.equal(ticks, 1, 'a panel opened in the other tab woke the engine here')

    stop()
    await settle(3)
    assert.equal(ticks, 0, 'and closing it put the engine back to sleep')
  })
})

describe('a fact a panel writes and reads back', () => {
  test('a port offered only as a fact is write-only, and that is worth knowing', async () => {
    const needle = port('', { name: 'needle' })
    const wire = wirePair()
    until(serve({ cells: {}, facts: { needle } }, wire.graph, { schedule: atOnce }))

    const watcher = link(wire.watcher)
    until(watcher.close)
    const mirror = watcher.derived<string>('needle')
    until(subscribe(mirror, () => {}))
    await settle(3)

    watcher.write('needle', 'alpha')
    await settle(3)

    assert.equal(needle.peek(), 'alpha', 'the write landed on the far side')
    // And there is nothing to read: a station that offers a port for writing
    // has not thereby offered it for looking at. A panel with a controlled
    // input reads an empty mirror forever — this is that bug, in one test.
    assert.equal(heldOf(mirror.peek())?.value, undefined)
  })

  test('offered both ways, the panel sees what it wrote', async () => {
    const needle = port('', { name: 'needle' })
    const wire = wirePair()
    until(serve({ cells: { needle }, facts: { needle } }, wire.graph, { schedule: atOnce }))

    const watcher = link(wire.watcher)
    until(watcher.close)
    const mirror = watcher.derived<string>('needle')
    until(subscribe(mirror, () => {}))
    await settle(3)

    watcher.write('needle', 'alpha')
    await settle(3)
    assert.equal(heldOf(mirror.peek())?.value, 'alpha')
  })

  test('a mirror of a name the station never published says so out loud', async () => {
    const heard: Array<{ where: string; message: string }> = []
    until(
      onNotice(what => {
        if (what.kind === 'mirror-refused') heard.push({ where: what.where, message: what.message })
      }),
    )

    const needle = port('', { name: 'needle' })
    const wire = wirePair()
    // Offered for writing only — the mistake this test exists for.
    until(serve({ cells: {}, facts: { needle } }, wire.graph, { schedule: atOnce }))

    const watcher = link(wire.watcher)
    until(watcher.close)
    until(subscribe(watcher.derived<string>('needle'), () => {}))
    await settle(3)

    assert.equal(heard.length, 1, 'said once, by name')
    assert.equal(heard[0]?.where, 'needle')
    assert.match(heard[0]?.message ?? '', /facts/, 'and says what to do about it')
  })

  test('a mirror that is published says nothing at all', async () => {
    const heard: unknown[] = []
    until(
      onNotice(what => {
        if (what.kind === 'mirror-refused') heard.push(what)
      }),
    )

    const needle = port('a', { name: 'needle' })
    const { watcher } = setupWire({ cells: { needle }, facts: { needle } })
    until(watcher.close)
    until(subscribe(watcher.derived<string>('needle'), () => {}))
    await settle(3)

    assert.deepEqual(heard, [])
  })
})
