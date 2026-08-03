import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MessageChannel } from 'node:worker_threads'
import { cell, input, subscribe } from '#core/graph.ts'
import { atOnce } from '#link/channel.ts'
import { channelOverPort, pairInMemory } from '#link/ports.ts'
import { link, Unknown } from '#link/link.ts'
import { serve } from '#link/serve.ts'

function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

/** A little world on the graph's side, with a source that knows who wants it. */
function world() {
  const awake: string[] = []
  const count = input(1, {
    onDemand: () => awake.push('start'),
    onIdle: () => awake.push('stop'),
  })
  const doubled = cell(() => count.get() * 2)
  const rows = input<Array<{ id: number; title: string }>>([{ id: 1, title: 'one' }])
  const byId = (id: number) => cell(() => rows.peek().find(row => row.id === id))

  return {
    awake,
    count,
    rows,
    surface: {
      cells: { count, doubled },
      families: { row: byId },
      commands: {
        add: (by: number) => {
          count.set(count.peek() + by)
          return count.peek()
        },
        refuse: () => {
          throw new Error('not today')
        },
      },
    },
  }
}

test('a mirrored cell shows what the other side holds, and follows it', async () => {
  const { surface, count } = world()
  const wire = pairInMemory()
  const stopServing = serve(surface, wire.graph, { schedule: atOnce })
  const seen = link(wire.watcher)

  const mirror = seen.cell<number>('count')
  const stop = subscribe(mirror, () => {})
  await settle()
  assert.equal(mirror.peek().value, 1)

  count.set(5)
  await settle()
  assert.equal(mirror.peek().value, 5)

  stop()
  seen.close()
  stopServing()
})

test('nothing is known until somebody watches', async () => {
  const { surface } = world()
  const wire = pairInMemory()
  const stopServing = serve(surface, wire.graph, { schedule: atOnce })
  const seen = link(wire.watcher)

  const mirror = seen.cell<number>('count')
  assert.equal(mirror.peek().kind, 'empty')
  await settle()
  assert.equal(mirror.peek().kind, 'empty') // asking is watching, and nobody watches

  seen.close()
  stopServing()
})

test('demand crosses the boundary: the source wakes and sleeps with the watcher', async () => {
  const { surface, awake } = world()
  const wire = pairInMemory()
  const stopServing = serve(surface, wire.graph, { schedule: atOnce })
  const seen = link(wire.watcher)

  const stop = subscribe(seen.cell<number>('doubled'), () => {})
  await settle()
  assert.deepEqual(awake, ['start'])

  stop()
  await settle()
  assert.deepEqual(awake, ['start', 'stop'])

  seen.close()
  stopServing()
})

test('a slow reader gets the latest value, not a queue of stale ones', async () => {
  const { surface, count } = world()
  const wire = pairInMemory()
  let held: Array<() => void> = []
  const stopServing = serve(surface, wire.graph, {
    schedule: work => {
      held.push(work)
    },
  })
  const sent: unknown[] = []
  wire.watcher.listen(message => sent.push(message))
  const seen = link(wire.watcher)

  const mirror = seen.cell<number>('count')
  const stop = subscribe(mirror, () => {})
  count.set(2)
  count.set(3)
  count.set(4)

  // Nothing has been flushed yet; one flush now carries one value per cell.
  assert.equal(sent.length, 0)
  const rounds = held
  held = []
  for (const work of rounds) work()
  await settle()

  assert.equal(sent.length, 1)
  const message = sent[0] as { changed: Array<{ value: unknown }> }
  assert.equal(message.changed.length, 1)
  assert.equal(mirror.peek().value, 4)

  stop()
  seen.close()
  stopServing()
})

test('a family is watched by name and key', async () => {
  const { surface } = world()
  const wire = pairInMemory()
  const stopServing = serve(surface, wire.graph, { schedule: atOnce })
  const seen = link(wire.watcher)

  const mirror = seen.cell<{ id: number; title: string }>('row', 1)
  const stop = subscribe(mirror, () => {})
  await settle()
  assert.deepEqual(mirror.peek().value, { id: 1, title: 'one' })

  stop()
  seen.close()
  stopServing()
})

test('a command runs on the other side and its answer comes back', async () => {
  const { surface, count } = world()
  const wire = pairInMemory()
  const stopServing = serve(surface, wire.graph, { schedule: atOnce })
  const seen = link(wire.watcher)

  const add = seen.command<[number], number>('add')
  assert.equal(await add(4), 5)
  assert.equal(count.peek(), 5)

  await assert.rejects(seen.command<[], void>('refuse')(), /not today/)
  await assert.rejects(seen.command<[], void>('nonesuch')(), /no command/)

  seen.close()
  stopServing()
})

test('asking for a cell the other side does not have says so', async () => {
  const { surface } = world()
  const wire = pairInMemory()
  const stopServing = serve(surface, wire.graph, { schedule: atOnce })
  const seen = link(wire.watcher)

  const mirror = seen.cell<number>('nonesuch')
  const stop = subscribe(mirror, () => {})
  await settle()
  assert.equal(mirror.peek().kind, 'failed') // told apart from "nothing yet"

  stop()
  seen.close()
  stopServing()
})

test('a value that cannot cross is reported, not swallowed', async () => {
  const bad = input<unknown>(() => 'a function cannot be cloned')
  const wire = pairInMemory()
  const complaints: string[] = []
  const stopServing = serve({ cells: { bad } }, wire.graph, {
    schedule: atOnce,
    onUnsendable: (_cell, error) => complaints.push(String(error).slice(0, 20)),
  })
  const seen = link(wire.watcher)

  const stop = subscribe(seen.cell('bad'), () => {})
  await settle()
  assert.equal(complaints.length, 1)

  stop()
  seen.close()
  stopServing()
})

test('the same over a real port, with real cloning', async () => {
  const { surface, count } = world()
  const ports = new MessageChannel()
  const stopServing = serve(surface, channelOverPort(ports.port1 as never), { schedule: atOnce })
  const seen = link(channelOverPort(ports.port2 as never))

  const mirror = seen.cell<number>('doubled')
  const stop = subscribe(mirror, () => {})
  await settle()
  assert.equal(mirror.peek().value, 2)

  count.set(10)
  await settle()
  assert.equal(mirror.peek().value, 20)

  const add = seen.command<[number], number>('add')
  assert.equal(await add(1), 11)

  stop()
  seen.close()
  stopServing()
  ports.port1.close()
  ports.port2.close()
})

test('unknown messages are ignored rather than fatal', () => {
  const wire = pairInMemory()
  const stopServing = serve({}, wire.graph, { schedule: atOnce })
  wire.watcher.send({ kind: 'nonsense' })
  wire.watcher.send(undefined)
  wire.watcher.send(42)
  stopServing()
})

test('a mirrored value keeps its shape through the wire', async () => {
  const rows = input([{ id: 1, tags: ['a', 'b'], at: new Date(0) }])
  const wire = pairInMemory()
  const stopServing = serve({ cells: { rows } }, wire.graph, { schedule: atOnce })
  const seen = link(wire.watcher)

  const mirror = seen.cell<Array<{ id: number; tags: string[]; at: Date }>>('rows')
  const stop = subscribe(mirror, () => {})
  await settle()
  const value = mirror.peek().value as Array<{ id: number; tags: string[]; at: Date }>
  assert.deepEqual(value[0]?.tags, ['a', 'b'])
  assert.ok(value[0]?.at instanceof Date)

  stop()
  seen.close()
  stopServing()
})

test('mirrors are shared: two watchers of one name ask once', async () => {
  const { surface } = world()
  const wire = pairInMemory()
  const asked: unknown[] = []
  wire.graph.listen(message => asked.push(message))
  const stopServing = serve(surface, wire.graph, { schedule: atOnce })
  const seen = link(wire.watcher)

  const first = subscribe(seen.cell<number>('count'), () => {})
  const second = subscribe(seen.cell<number>('count'), () => {})
  await settle()
  assert.equal(asked.filter(m => (m as { kind: string }).kind === 'watch').length, 1)

  first()
  await settle()
  assert.equal(asked.filter(m => (m as { kind: string }).kind === 'unwatch').length, 0)
  second()
  await settle()
  assert.equal(asked.filter(m => (m as { kind: string }).kind === 'unwatch').length, 1)

  seen.close()
  stopServing()
})

test('a mirror forgets what it knew when the last watcher goes', async () => {
  const { surface } = world()
  const wire = pairInMemory()
  const stopServing = serve(surface, wire.graph, { schedule: atOnce })
  const seen = link(wire.watcher)

  const mirror = seen.cell<number>('count')
  const stop = subscribe(mirror, () => {})
  await settle()
  assert.equal(mirror.peek().kind, 'value')
  stop()
  await settle()
  // Stale is worse than unknown: nothing is watching, so nothing is being told.
  assert.equal(mirror.peek().kind, 'empty')

  seen.close()
  stopServing()
})

test('closing the link leaves waiting calls unknown, not refused', async () => {
  const wire = pairInMemory()
  const seen = link(wire.watcher)
  const slow = seen.command<[], void>('add')()
  seen.close()
  // The command may have run on the other side; closing our end cannot unsay it.
  await assert.rejects(slow, Unknown)
})

test('a graph restart leaves waiting calls unknown, not refused', async () => {
  const wire = pairInMemory()
  const never = serve({ commands: { forever: () => new Promise(() => {}) } }, wire.graph, {
    schedule: atOnce,
  })
  const seen = link(wire.watcher)

  const slow = seen.command<[], void>('forever')()
  await settle()

  // The graph comes back knowing nothing of the call it was answering.
  never()
  const again = serve({ commands: {} }, wire.graph, { schedule: atOnce })
  await assert.rejects(slow, Unknown)

  seen.close()
  again()
})

test('one value that cannot cross does not cost the others theirs', async () => {
  const good = input(1)
  const bad = input<unknown>(() => 'a function cannot be cloned')
  const wire = pairInMemory()
  const complaints: string[] = []
  const stopServing = serve({ cells: { good, bad } }, wire.graph, {
    schedule: atOnce,
    onUnsendable: name => complaints.push(name),
  })
  const seen = link(wire.watcher)

  const mirror = seen.cell<number>('good')
  const stopGood = subscribe(mirror, () => {})
  const stopBad = subscribe(seen.cell('bad'), () => {})
  await settle()
  assert.equal(mirror.peek().value, 1)
  assert.deepEqual(complaints, ['bad'])

  // Both change in one batch: the good one still gets through.
  good.set(2)
  bad.set(() => 'still not cloneable')
  await settle()
  assert.equal(mirror.peek().value, 2)
  assert.deepEqual(complaints, ['bad', 'bad'])

  stopGood()
  stopBad()
  seen.close()
  stopServing()
})

test('closing the link lets the graph go: unwatch for every mirror still watched', async () => {
  const { surface, awake } = world()
  const wire = pairInMemory()
  const stopServing = serve(surface, wire.graph, { schedule: atOnce })
  const seen = link(wire.watcher)

  const stop = subscribe(seen.cell<number>('count'), () => {})
  await settle()
  assert.deepEqual(awake, ['start'])

  // The tab side is done; the graph must not keep the source warm for a wire
  // nobody is on any more.
  seen.close()
  await settle()
  assert.deepEqual(awake, ['start', 'stop'])

  stop()
  stopServing()
})

test('an ask over the wire waits only so long: past the term the outcome is unknown', async () => {
  const clockwork = (() => {
    let time = 0
    let id = 1
    const jobs = new Map<number, { at: number; fn: () => void }>()
    return {
      timers: {
        set: (fn: () => void, ms: number) => {
          const handle = id++
          jobs.set(handle, { at: time + ms, fn })
          return handle
        },
        clear: (handle: unknown) => {
          jobs.delete(handle as number)
        },
      },
      async advance(ms: number) {
        const until = time + ms
        // Snapshot: the loop deletes from `jobs` as it runs them.
        // oxlint-disable-next-line unicorn/no-useless-spread
        for (const [handle, job] of [...jobs]) {
          if (job.at > until) continue
          jobs.delete(handle)
          job.fn()
        }
        time = until
        await settle()
      },
    }
  })()

  const wire = pairInMemory()
  const never = serve({ commands: { forever: () => new Promise(() => {}) } }, wire.graph, {
    schedule: atOnce,
  })
  const seen = link(wire.watcher, { within: 2000, timers: clockwork.timers })

  const slow = seen.command<[], void>('forever')()
  const outcome = assert.rejects(slow, Unknown)
  await settle()
  await clockwork.advance(2000)
  await outcome

  seen.close()
  never()
})

test('perFrame does not wait for a frame that never comes: a background tab still serves', async () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame')
  // The browser of a background tab: frames are frozen, the callback never fires.
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    value: () => 0,
    configurable: true,
  })
  try {
    const { perFrame: frozenFrame } = await import('#link/channel.ts')
    const ran: number[] = []
    frozenFrame(() => ran.push(1))
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.deepEqual(ran, [1]) // the timer raced the frame and won
  } finally {
    if (had === undefined)
      delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
    else Object.defineProperty(globalThis, 'requestAnimationFrame', had)
  }
})

test('an idle mirror lingers, then is let go; a fresh look brings it back', async () => {
  const { heldOf } = await import('#core/remote.ts')
  const rest = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
  const pair = pairInMemory()
  const feed = input(1, { name: 'n' })
  const stopServe = serve({ cells: { n: feed } }, pair.graph, { schedule: atOnce })
  const wire = link(pair.watcher, { linger: 40 })

  const face = wire.cell<number>('n')
  const stop = subscribe(face, () => {})
  assert.equal(wire.held(), 1)
  stop()
  assert.equal(wire.held(), 1) // idle, but lingering
  await rest(60)
  assert.equal(wire.held(), 0) // let go

  const again = subscribe(face, () => {}) // the old handle looks again
  assert.equal(wire.held(), 1) // the very same mirror re-registered
  await rest(5)
  assert.equal(heldOf(face.peek())?.value, 1) // and values flow to it again
  again()
  stopServe()
  wire.close()
})
