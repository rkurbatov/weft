import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { MessageChannel } from 'node:worker_threads'
import { derived, port, subscribe } from '#graph/graph.ts'
import type { Timers } from '#graph/time.ts'
import { atOnce } from '#link/channel.ts'
import { busHub, busChannel, heartbeat } from '#link/bus.ts'
import { sharedWorkerChannel, sharedWorkerHub } from '#link/shared.ts'
import type { SharedScope } from '#link/shared.ts'
import type { Wire } from '#link/wires.ts'
import { wirePair } from '#link/wires.ts'
import { leadOrFollow, webLocks } from '#link/lead.ts'
import type { Lock } from '#link/lead.ts'
import { link } from '#link/link.ts'
import { serve } from '#link/serve.ts'
import { settle } from '#testkit'

describe('tabs and leadership', () => {
  // A bus message takes a turn each way, and a hello-then-watch takes several.

  function scene() {
    const count = port(1)
    return {
      count,
      surface: {
        cells: { count, doubled: derived(() => count.get() * 2) },
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
    const { surface, count } = scene()
    const buses = busPair('weft-test-a')
    const stopHub = busHub('weft-test-a', buses.make()).accept(channel =>
      serve(surface, channel, { schedule: atOnce }),
    )

    const first = link(busChannel('weft-test-a', buses.make()))
    const second = link(busChannel('weft-test-a', buses.make()))
    const mirrorOne = first.derived<number>('count')
    const mirrorTwo = second.derived<number>('doubled')
    const stopOne = subscribe(mirrorOne, () => {})
    const stopTwo = subscribe(mirrorTwo, () => {})
    await settle(4)

    assert.equal(mirrorOne.peek().value, 1)
    assert.equal(mirrorTwo.peek().value, 2)

    count.set(4)
    await settle(4)
    assert.equal(mirrorOne.peek().value, 4)
    assert.equal(mirrorTwo.peek().value, 8)

    stopOne()
    stopTwo()
    first.close()
    second.close()
    stopHub()
    buses.closeAll()
  })

  test('a command from one tab is seen by the other', async () => {
    const { surface } = scene()
    const buses = busPair('weft-test-b')
    const stopHub = busHub('weft-test-b', buses.make()).accept(channel =>
      serve(surface, channel, { schedule: atOnce }),
    )

    const writer = link(busChannel('weft-test-b', buses.make()))
    const reader = link(busChannel('weft-test-b', buses.make()))
    const mirror = reader.derived<number>('count')
    const stop = subscribe(mirror, () => {})
    await settle(4)

    await writer.command<[number], void>('add')(9)
    await settle(4)
    assert.equal(mirror.peek().value, 10)

    stop()
    writer.close()
    reader.close()
    stopHub()
    buses.closeAll()
  })

  test('a watcher asks again when the graph announces itself', async () => {
    const { surface, count } = scene()
    const wire = wirePair()
    let stopServing = serve(surface, wire.graph, { schedule: atOnce })
    const seen = link(wire.watcher)

    const mirror = seen.derived<number>('count')
    const stop = subscribe(mirror, () => {})
    await settle(4)
    assert.equal(mirror.peek().value, 1)

    // The graph goes away and comes back knowing nothing of who was watching.
    stopServing()
    count.set(7)
    stopServing = serve(surface, wire.graph, { schedule: atOnce })
    await settle(4)
    assert.equal(mirror.peek().value, 7)

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

  /** Just enough of navigator.locks: one holder at a time, the rest queue in order. */
  function fakeLocks() {
    const queue: Array<() => void> = []
    let busy = false

    const give = (): void => {
      if (busy) return
      const turn = queue.shift()
      if (turn === undefined) return
      busy = true
      turn()
    }

    return {
      waiting: () => queue.length,
      manager: {
        request(_name: string, options: { signal: AbortSignal }, body: () => Promise<void>) {
          return new Promise<void>((resolve, reject) => {
            const take = (): void => {
              void body().then(() => {
                busy = false
                resolve()
                give()
              })
            }
            queue.push(take)
            options.signal.addEventListener('abort', () => {
              const at = queue.indexOf(take)
              if (at < 0) return
              queue.splice(at, 1)
              reject(new Error('AbortError'))
            })
            give()
          })
        },
      },
    }
  }

  test('a tab that stops waiting for the lock gives up its place in the queue', async () => {
    const locks = fakeLocks()
    const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', {
      value: { locks: locks.manager },
      configurable: true,
    })

    try {
      const lock = webLocks()
      const doing: string[] = []
      const first = lock.hold('graph', () => doing.push('first leads'))
      const second = lock.hold('graph', () => doing.push('second leads'))
      const third = lock.hold('graph', () => doing.push('third leads'))
      assert.deepEqual(doing, ['first leads'])
      assert.equal(locks.waiting(), 2)

      second() // this tab is gone before the lock ever reached it
      assert.equal(locks.waiting(), 1)

      first()
      await settle(1)
      assert.deepEqual(doing, ['first leads', 'third leads'])

      third()
    } finally {
      if (had === undefined) delete (globalThis as { navigator?: unknown }).navigator
      else Object.defineProperty(globalThis, 'navigator', had)
    }
  })

  /** Hand-made timers: nothing fires until time is moved, then jobs run in order. */
  function fakeTimers() {
    let time = 0
    let next = 1
    const jobs = new Map<number, { at: number; fn: () => void }>()
    const timers: Timers = {
      set: (fn, ms) => {
        const id = next++
        jobs.set(id, { at: time + ms, fn })
        return id
      },
      clear: handle => {
        jobs.delete(handle as number)
      },
    }
    return {
      timers,
      async advance(ms: number) {
        const until = time + ms
        for (;;) {
          const due = [...jobs.entries()]
            .filter(([, job]) => job.at <= until)
            .toSorted((a, b) => a[1].at - b[1].at)[0]
          if (due === undefined) break
          const [id, job] = due
          jobs.delete(id)
          time = job.at
          job.fn()
          await settle(4)
        }
        time = until
        await settle(4)
      },
    }
  }

  test('the hub lets go of a tab that fell silent, and keeps serving the live one', async () => {
    const clock = fakeTimers()
    const awake: string[] = []
    const talking = port(1, {
      onDemand: () => awake.push('start'),
      onIdle: () => awake.push('stop'),
    })
    const silent = port(10)
    const surface = { cells: { talking, silent } }
    const buses = busPair('weft-test-lease')
    const stopHub = busHub('weft-test-lease', buses.make(), {
      lease: 15_000,
      timers: clock.timers,
    }).accept(channel => serve(surface, channel, { schedule: atOnce }))

    const alive = link(
      busChannel('weft-test-lease', buses.make(), { keepAlive: 5_000, timers: clock.timers }),
    )
    const dead = link(busChannel('weft-test-lease', buses.make(), { keepAlive: false }))
    const aliveMirror = alive.derived<number>('silent')
    const deadMirror = dead.derived<number>('talking')
    const stopAlive = subscribe(aliveMirror, () => {})
    const stopDead = subscribe(deadMirror, () => {})
    await settle(4)
    assert.equal(aliveMirror.peek().value, 10)
    assert.equal(deadMirror.peek().value, 1)
    assert.deepEqual(awake, ['start'])

    await clock.advance(16_000)
    // The silent tab's lease ran out: its watches are gone and demand fell with them.
    assert.deepEqual(awake, ['start', 'stop'])

    // The tab that kept beating is still served.
    silent.set(11)
    await settle(4)
    assert.equal(aliveMirror.peek().value, 11)

    // A tab let go by mistake recovers by speaking: the hub hands it a fresh
    // channel, whose serve announces itself, and the link re-asks on its own.
    dead.rewatch()
    await settle(4)
    talking.set(2)
    await settle(4)
    assert.equal(deadMirror.peek().value, 2)

    stopAlive()
    stopDead()
    alive.close()
    dead.close()
    stopHub()
    buses.closeAll()
  })

  test('the shared-worker hub lets go of a tab that fell silent', async () => {
    const clock = fakeTimers()
    const awake: string[] = []
    const talking = port(1, {
      onDemand: () => awake.push('start'),
      onIdle: () => awake.push('stop'),
    })
    const lonely = port(10, {
      onDemand: () => awake.push('lonely starts'),
      onIdle: () => awake.push('lonely stops'),
    })
    const surface = { cells: { talking, lonely } }

    const listeners = new Set<(event: { ports: readonly Wire[] }) => void>()
    const scope: SharedScope = {
      addEventListener: (_kind, handler) => listeners.add(handler),
      removeEventListener: (_kind, handler) => listeners.delete(handler),
    }
    const stopHub = sharedWorkerHub(scope, { lease: 15_000, timers: clock.timers }).accept(
      channel => serve(surface, channel, { schedule: atOnce }),
    )

    const live = new MessageChannel()
    const gone = new MessageChannel()
    for (const pair of [live, gone]) {
      for (const arrival of listeners) arrival({ ports: [pair.port1 as unknown as Wire] })
    }
    const alive = link(
      sharedWorkerChannel(live.port2 as unknown as Wire, {
        keepAlive: 5_000,
        timers: clock.timers,
      }),
    )
    const dead = link(sharedWorkerChannel(gone.port2 as unknown as Wire, { keepAlive: false }))

    const aliveMirror = alive.derived<number>('talking')
    const deadMirror = dead.derived<number>('lonely')
    const stopAlive = subscribe(aliveMirror, () => {})
    const stopDead = subscribe(deadMirror, () => {})
    await settle(4)
    assert.equal(aliveMirror.peek().value, 1)
    assert.equal(deadMirror.peek().value, 10)
    assert.deepEqual(awake, ['start', 'lonely starts'])

    await clock.advance(16_000)
    // The silent tab is let go; only its own demand falls.
    assert.deepEqual(awake, ['start', 'lonely starts', 'lonely stops'])
    talking.set(2)
    await settle(4)
    assert.equal(aliveMirror.peek().value, 2)

    stopAlive()
    stopDead()
    alive.close()
    dead.close()
    stopHub()
    live.port1.close()
    live.port2.close()
    gone.port1.close()
    gone.port2.close()
  })

  test('the heartbeat introduces itself fast and settles down to its pace', async () => {
    const clock = fakeTimers()
    const beats: number[] = []
    const stop = heartbeat(() => beats.push(beats.length), 5000, clock.timers)

    await clock.advance(250)
    // A lost first hello costs a fraction of a second, not a settled beat.
    assert.equal(beats.length, 1)
    await clock.advance(750)
    assert.equal(beats.length, 2) // 200ms, then 600ms — doubling toward the pace

    await clock.advance(6000) // the doubling runs its course
    beats.length = 0
    await clock.advance(15_000)
    assert.equal(beats.length, 3) // settled: one beat per five seconds
    stop()
  })
})
