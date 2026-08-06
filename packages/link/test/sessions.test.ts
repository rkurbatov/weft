// Two people, one browser.
//
// The engine keeps their graphs apart; this is the other half — the disk and
// the wire. Kept things live under an application and a session, logging out
// clears what can be fetched again and leaves what was entrusted to us, and a
// station holding one household refuses a tab belonging to another by name.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { busChannel, busHub, heldOf, port, memoryStore, serve, subscribe, within } from '#weft'
import { link } from '#link'
import { onBus, settle, until } from '#testkit'

describe('sessions apart', () => {
  const settle = async (turns = 4): Promise<void> => {
    for (let i = 0; i < turns; i++) await new Promise(resolve => setTimeout(resolve, 0))
  }

  test('two sessions in one browser do not see each other on disk', async () => {
    const disk = memoryStore()
    const ann = within(disk, 'rail', 'ann')
    const bob = within(disk, 'rail', 'bob')

    await ann.write(ann.cache('picked'), 'game-7')
    await bob.write(bob.cache('picked'), 'game-9')

    assert.equal(await ann.read(ann.cache('picked')), 'game-7')
    assert.equal(await bob.read(bob.cache('picked')), 'game-9')

    // And neither of them can even name the other's keys.
    assert.deepEqual(await ann.keys(), ['cache/picked'])
    assert.deepEqual((await disk.keys()).toSorted(), [
      'rail/ann/cache/picked',
      'rail/bob/cache/picked',
    ])
  })

  test('logging out clears what can be fetched again and keeps what was entrusted', async () => {
    const disk = memoryStore()
    const ann = within(disk, 'rail', 'ann')
    const common = within(disk, 'rail', 'common')

    await ann.write(ann.cache('games'), ['a', 'b'])
    await ann.write(ann.book('note-1'), { text: 'not sent yet' })
    await common.write(common.cache('rates'), { eur: 2 })

    await ann.wipe()

    assert.equal(await ann.read(ann.cache('games')), undefined)
    // The note belongs to the person who wrote it, and waits for their return.
    assert.deepEqual(await ann.read(ann.book('note-1')), { text: 'not sent yet' })
    // What belongs to nobody is nobody's to clear.
    assert.deepEqual(await common.read(common.cache('rates')), { eur: 2 })

    // Coming back: the same scope name finds the same book.
    const annAgain = within(disk, 'rail', 'ann')
    assert.deepEqual(await annAgain.read(annAgain.book('note-1')), { text: 'not sent yet' })
  })

  test('two applications of one person keep their own kept things', async () => {
    const disk = memoryStore()
    const rail = within(disk, 'rail', 'ann')
    const board = within(disk, 'kanban', 'ann')

    await rail.write(rail.cache('picked'), 'game-7')
    await board.write(board.cache('picked'), 'card-3')

    assert.equal(await rail.read(rail.cache('picked')), 'game-7')
    assert.equal(await board.read(board.cache('picked')), 'card-3')

    // Logging out of one application does not empty the other.
    await rail.wipe()
    assert.equal(await rail.read(rail.cache('picked')), undefined)
    assert.equal(await board.read(board.cache('picked')), 'card-3')
  })

  test('a scope name cannot be forged out of a slash', () => {
    const disk = memoryStore()
    assert.throws(() => within(disk, 'rail', 'ann/../bob'), /cannot be part of a scope name/)
  })

  test("a station serving one household refuses another's tab by name", async () => {
    const bus = (): Parameters<typeof busHub>[1] =>
      onBus('station') as unknown as Parameters<typeof busHub>[1]
    const seats = port(3, { name: 'seats' })
    const hub = busHub('station', bus(), { admit: claim => claim === 'ann', lease: false })
    const stopServing = hub.accept(channel =>
      serve({ cells: { seats } }, channel, { schedule: fn => fn() }),
    )

    const hers = link(busChannel('station', bus(), { claim: 'ann' }))
    const his = link(busChannel('station', bus(), { claim: 'bob' }), {
      onRefused: why => refusals.push(why),
    })
    const refusals: string[] = []

    const seenByAnn: unknown[] = []
    const stopAnn = subscribe(hers.derived<number>('seats'), remote => {
      const held = heldOf(remote)
      if (held !== undefined) seenByAnn.push(held.value)
    })
    const seenByBob: unknown[] = []
    const stopBob = subscribe(his.derived<number>('seats'), remote => {
      const held = heldOf(remote)
      if (held !== undefined) seenByBob.push(held.value)
    })
    await settle()

    assert.deepEqual(seenByAnn, [3])
    // Nothing arrives for the other session — and it is told why rather than
    // left to watch a spinner.
    assert.deepEqual(seenByBob, [])
    assert.equal(refusals.length > 0, true)
    assert.match(refusals[0] ?? '', /session/)

    stopAnn()
    stopBob()
    hers.close()
    his.close()
    stopServing()
  })
})
