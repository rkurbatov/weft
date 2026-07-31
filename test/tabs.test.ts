import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cell, input, subscribe } from '#core/graph.ts'
import { atOnce, valueOf } from '#link/channel.ts'
import { busHub, channelOverBus } from '#link/bus.ts'
import { pairInMemory } from '#link/channels.ts'
import { leadOrFollow } from '#link/lead.ts'
import type { Lock } from '#link/lead.ts'
import { link } from '#link/link.ts'
import { serve } from '#link/serve.ts'

/** A bus message takes a turn each way, and a hello-then-watch takes several. */
async function settle(turns = 4): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

function world() {
  const count = input(1)
  return {
    count,
    surface: {
      cells: { count, doubled: cell(() => count.get() * 2) },
      commands: { add: (by: number) => count.set(count.peek() + by) },
    },
  }
}

/** One bus per test, closed at the end so the process can exit. */
function busPair(name: string) {
  const open = (): BroadcastChannel => new BroadcastChannel(name)
  const buses: BroadcastChannel[] = []
  return {
    make: () => {
      const bus = open()
      buses.push(bus)
      return bus as unknown as Parameters<typeof busHub>[1]
    },
    closeAll: () => {
      for (const bus of buses) bus.close()
    },
  }
}

test('two tabs watch one graph over the bus, each served on its own', async () => {
  const { surface, count } = world()
  const buses = busPair('weft-test-a')
  const stopHub = busHub('weft-test-a', buses.make()).accept(channel =>
    serve(surface, channel, { schedule: atOnce }),
  )

  const first = link(channelOverBus('weft-test-a', buses.make()))
  const second = link(channelOverBus('weft-test-a', buses.make()))
  const mirrorOne = first.cell<number>('count')
  const mirrorTwo = second.cell<number>('doubled')
  const stopOne = subscribe(mirrorOne, () => {})
  const stopTwo = subscribe(mirrorTwo, () => {})
  await settle()

  assert.equal(valueOf(mirrorOne.peek()), 1)
  assert.equal(valueOf(mirrorTwo.peek()), 2)

  count.set(4)
  await settle()
  assert.equal(valueOf(mirrorOne.peek()), 4)
  assert.equal(valueOf(mirrorTwo.peek()), 8)

  stopOne()
  stopTwo()
  first.close()
  second.close()
  stopHub()
  buses.closeAll()
})

test('a command from one tab is seen by the other', async () => {
  const { surface } = world()
  const buses = busPair('weft-test-b')
  const stopHub = busHub('weft-test-b', buses.make()).accept(channel =>
    serve(surface, channel, { schedule: atOnce }),
  )

  const writer = link(channelOverBus('weft-test-b', buses.make()))
  const reader = link(channelOverBus('weft-test-b', buses.make()))
  const mirror = reader.cell<number>('count')
  const stop = subscribe(mirror, () => {})
  await settle()

  await writer.command<[number], void>('add')(9)
  await settle()
  assert.equal(valueOf(mirror.peek()), 10)

  stop()
  writer.close()
  reader.close()
  stopHub()
  buses.closeAll()
})

test('a watcher asks again when the graph announces itself', async () => {
  const { surface, count } = world()
  const wire = pairInMemory()
  let stopServing = serve(surface, wire.graph, { schedule: atOnce })
  const seen = link(wire.watcher)

  const mirror = seen.cell<number>('count')
  const stop = subscribe(mirror, () => {})
  await settle()
  assert.equal(valueOf(mirror.peek()), 1)

  // The graph goes away and comes back knowing nothing of who was watching.
  stopServing()
  count.set(7)
  stopServing = serve(surface, wire.graph, { schedule: atOnce })
  await settle()
  assert.equal(valueOf(mirror.peek()), 7)

  stop()
  seen.close()
  stopServing()
})

/** A lock two participants can queue for, handed on in order. */
function queueingLock() {
  const waiting: Array<{ name: string; onHeld: () => void }> = []
  const held = new Map<string, () => void>()

  const give = (name: string): void => {
    if (held.has(name)) return
    const next = waiting.find(one => one.name === name)
    if (next === undefined) return
    waiting.splice(waiting.indexOf(next), 1)
    held.set(name, next.onHeld)
    next.onHeld()
  }

  const lock: Lock = {
    hold(name, onHeld) {
      waiting.push({ name, onHeld })
      give(name)
      return () => {
        const mine = waiting.find(one => one.onHeld === onHeld)
        if (mine !== undefined) waiting.splice(waiting.indexOf(mine), 1)
        if (held.get(name) === onHeld) {
          held.delete(name)
          give(name)
        }
      }
    },
  }
  return lock
}

test('the first tab leads, the second follows, and takes over when the first goes', () => {
  const lock = queueingLock()
  const doing: string[] = []
  const start = (who: string) =>
    leadOrFollow({
      name: 'graph',
      lock,
      lead: () => {
        doing.push(`${who} leads`)
        return () => doing.push(`${who} stops leading`)
      },
      follow: () => {
        doing.push(`${who} follows`)
        return () => doing.push(`${who} stops following`)
      },
    })

  const first = start('first')
  assert.deepEqual(doing, ['first follows', 'first stops following', 'first leads'])

  const second = start('second')
  assert.deepEqual(doing.slice(3), ['second follows'])

  first()
  assert.deepEqual(doing.slice(4), [
    'first stops leading',
    'second stops following',
    'second leads',
  ])

  second()
})

test('a tab that never gets the lock just keeps watching', () => {
  const lock: Lock = { hold: () => () => {} } // nobody is ever given it
  const doing: string[] = []
  const stop = leadOrFollow({
    name: 'graph',
    lock,
    lead: () => {
      doing.push('leads')
      return () => {}
    },
    follow: () => {
      doing.push('follows')
      return () => doing.push('stops following')
    },
  })
  assert.deepEqual(doing, ['follows'])
  stop()
  assert.deepEqual(doing, ['follows', 'stops following'])
})
