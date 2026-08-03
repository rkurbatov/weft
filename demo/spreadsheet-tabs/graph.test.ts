import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subscribe } from '#weft'
import { busHub, channelOverBus } from '#weft'
import type { Lock } from '#weft'
import { joinSheet } from './graph.ts'
import type { TabWorld } from './graph.ts'

/** Bus messages take turns; a watch-and-answer takes several. */
async function settle(turns = 6): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

/** A lock handed on in order, as the browser hands its web lock. */
function queueingLock() {
  const waiting: Array<{ onHeld: () => void }> = []
  let holder: (() => void) | undefined
  const give = (): void => {
    if (holder !== undefined) return
    const next = waiting.shift()
    if (next === undefined) return
    holder = next.onHeld
    next.onHeld()
  }
  const lock: Lock = {
    hold(_name, onHeld) {
      waiting.push({ onHeld })
      give()
      return () => {
        const queued = waiting.findIndex(one => one.onHeld === onHeld)
        if (queued >= 0) waiting.splice(queued, 1)
        if (holder === onHeld) {
          holder = undefined
          give()
        }
      }
    },
  }
  return lock
}

function testWorld(name: string) {
  const lock = queueingLock()
  const buses: BroadcastChannel[] = []
  const bus = () => {
    const one = new BroadcastChannel(name)
    buses.push(one)
    return one as unknown as Parameters<typeof busHub>[1]
  }
  const world: TabWorld = {
    hub: () => busHub(name, bus()),
    channel: () => channelOverBus(name, bus()),
    lock,
    shape: { rows: 4, cols: 3 },
  }
  return { world, closeAll: () => buses.forEach(one => one.close()) }
}

test('two windows, one sheet: an edit in either is seen in both', async () => {
  const { world, closeAll } = testWorld('sheet-tabs-a')
  const first = joinSheet(world)
  const second = joinSheet(world)

  const mineB1 = first.seen.cell<string>('shown', 'B1')
  const theirsB1 = second.seen.cell<string>('shown', 'B1')
  const stopMine = subscribe(mineB1, () => {})
  const stopTheirs = subscribe(theirsB1, () => {})
  await settle()

  assert.equal(first.role.peek(), 'leading')
  assert.equal(second.role.peek(), 'following')
  assert.equal(mineB1.peek().value, '2') // =A1 * 2 over A1 = 1

  // The FOLLOWING window edits; the sheet lives in the other one.
  await second.seen.command<[string, string], void>('set')('A1', '10')
  await settle()
  assert.equal(mineB1.peek().value, '20')
  assert.equal(theirsB1.peek().value, '20')

  stopMine()
  stopTheirs()
  first.stop()
  second.stop()
  closeAll()
})

test('the leading window closes; the other takes the sheet over and serves on', async () => {
  const { world, closeAll } = testWorld('sheet-tabs-b')
  const first = joinSheet(world)
  const second = joinSheet(world)

  const shown = second.seen.cell<string>('shown', 'C1')
  const stop = subscribe(shown, () => {})
  await settle()
  assert.equal(shown.peek().value, '3') // =B1 + A1

  first.stop() // the leading window is gone; the lock frees, the second leads
  await settle()

  // The fresh sheet announces itself and the mirror re-asks on its own.
  assert.equal(shown.peek().value, '3')
  await second.seen.command<[string, string], void>('set')('A1', '5')
  await settle()
  assert.equal(shown.peek().value, '15') // 5*2 + 5, computed by the new leader

  stop()
  second.stop()
  closeAll()
})
