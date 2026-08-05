// The protocol over a transport made of two functions.
//
// The point of the split: `bus.ts` is who is served and for how long,
// `postbox.ts` is who a message is for, `transport.ts` is the carrying. Which
// means the whole tab protocol can be exercised over a line that is a set of
// callbacks — no browser, no worker threads, no waiting for real messages.
//
// If a future transport (a websocket, a native port, something not invented
// yet) implements four methods, everything here holds for it too.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { heldOf, port, subscribe } from '#weft'
import { busChannel, busHub } from '#ipc/bus.ts'
import { link } from '#ipc/link.ts'
import { claimOf, greeting, isGreeting, postbox } from '#ipc/postbox.ts'
import { serve } from '#ipc/serve.ts'
import { localBroadcast } from '#ipc/transport.ts'
import type { Broadcast } from '#ipc/transport.ts'
import { settle, until, world } from '../../kit/index.ts'

const atOnce = (work: () => void): void => work()

describe('a transport is four methods and no knowledge', () => {
  test('a line in memory carries to everyone listening, sender included', () => {
    const line = localBroadcast()
    const heard: string[] = []
    until(line.on(m => heard.push(`first: ${String(m)}`)))
    until(line.on(m => heard.push(`second: ${String(m)}`)))

    line.post('hello')
    assert.deepEqual(heard, ['first: hello', 'second: hello'])
  })

  test('closing a line ends every listening', () => {
    const line = localBroadcast()
    let heard = 0
    line.on(() => heard++)
    line.close()
    line.post('anything')
    assert.equal(heard, 0)
  })
})

describe('addressing, over any line at all', () => {
  test('a letter reaches the one it names, and nobody else', () => {
    const line = localBroadcast()
    const ann = postbox(line, 'ann')
    const bob = postbox(line, 'bob')
    const forAnn: unknown[] = []
    const forBob: unknown[] = []
    until(ann.listen((_from, body) => forAnn.push(body)))
    until(bob.listen((_from, body) => forBob.push(body)))

    bob.send('ann', 'for you')
    assert.deepEqual(forAnn, ['for you'])
    assert.deepEqual(forBob, [], 'the sender does not hear its own letter')
  })

  test('a letter to everyone reaches everyone', () => {
    const line = localBroadcast()
    const heard: string[] = []
    until(postbox(line, 'ann').listen((from, body) => heard.push(`${from}:${String(body)}`)))
    until(postbox(line, 'bob').listen((from, body) => heard.push(`${from}:${String(body)}`)))
    postbox(line, 'graph').send('all', 'up')
    assert.deepEqual(heard, ['graph:up', 'graph:up'])
  })

  test('a greeting says hello, and may say whose tab it is', () => {
    assert.equal(isGreeting(greeting(undefined)), true)
    assert.equal(claimOf(greeting(undefined)), undefined)
    assert.equal(claimOf(greeting('ann')), 'ann')
    assert.equal(isGreeting({ kind: 'up' }), false)
  })

  test('what is inside an envelope is none of the postbox’s business', () => {
    const line = localBroadcast()
    const seen: unknown[] = []
    until(postbox(line, 'ann').listen((_from, body) => seen.push(body)))
    // Nothing weft-shaped about it: it is carried all the same.
    postbox(line, 'bob').send('ann', { anything: [1, 2, 3] })
    assert.deepEqual(seen, [{ anything: [1, 2, 3] }])
  })
})

describe('the tab protocol over a line of callbacks', () => {
  test('a watcher is met, served, and hears changes', async () => {
    const line = localBroadcast()
    const seats = port(3, { name: 'seats' })

    const hub = busHub('station', line, { lease: false })
    until(hub.accept(channel => serve({ cells: { seats } }, channel, { schedule: atOnce })))

    const watcher = link(busChannel('station', line, { keepAlive: false }))
    const seen: number[] = []
    until(
      subscribe(watcher.derived<number>('seats'), remote => {
        const held = heldOf(remote)
        if (held !== undefined) seen.push(held.value)
      }),
    )
    until(() => watcher.close())

    await settle(2)
    assert.deepEqual(seen, [3])
    seats.set(4)
    await settle(2)
    assert.deepEqual(seen, [3, 4])
  })

  test('a silent tab loses its lease, and its demand with it', async () => {
    const time = world()
    const line = localBroadcast()
    const asked: string[] = []
    const seats = port(1, {
      name: 'seats',
      onDemand: () => asked.push('on'),
      onIdle: () => asked.push('off'),
    })

    const hub = busHub('station', line, { lease: 1000, timers: time.timers })
    until(hub.accept(channel => serve({ cells: { seats } }, channel, { schedule: atOnce })))

    const watcher = link(busChannel('station', line, { keepAlive: false, timers: time.timers }))
    const stop = subscribe(watcher.derived<number>('seats'), () => {})
    await settle(2)
    assert.deepEqual(asked, ['on'])

    // The tab says nothing at all — as a tab that was closed would.
    await time.advance(1200)
    await settle(2)
    assert.deepEqual(asked, ['on', 'off'], 'the lease ran out and the watch went with it')

    stop()
    watcher.close()
  })

  test('a hub that holds one household refuses another, by name', async () => {
    const line = localBroadcast()
    const seats = port(1, { name: 'seats' })
    const hub = busHub('station', line, { lease: false, admit: claim => claim === 'ann' })
    until(hub.accept(channel => serve({ cells: { seats } }, channel, { schedule: atOnce })))

    const refusals: string[] = []
    const theirs = link(busChannel('station', line, { claim: 'bob', keepAlive: false }), {
      onRefused: why => refusals.push(why),
    })
    const seen: number[] = []
    const stop = subscribe(theirs.derived<number>('seats'), remote => {
      const held = heldOf(remote)
      if (held !== undefined) seen.push(held.value)
    })

    await settle(2)
    assert.deepEqual(seen, [])
    assert.equal(refusals.length > 0, true)

    stop()
    theirs.close()
  })

  test('a transport of one’s own needs four methods and nothing else', async () => {
    // Written out by hand, to show how little a transport has to be.
    const listeners = new Set<(message: unknown) => void>()
    const mine: Broadcast = {
      post: message => {
        for (const listener of Array.from(listeners)) listener(message)
      },
      on(handler) {
        listeners.add(handler)
        return () => listeners.delete(handler)
      },
      close: () => listeners.clear(),
    }

    const seats = port(7, { name: 'seats' })
    const hub = busHub('station', mine, { lease: false })
    until(hub.accept(channel => serve({ cells: { seats } }, channel, { schedule: atOnce })))

    const watcher = link(busChannel('station', mine, { keepAlive: false }))
    const seen: number[] = []
    const stop = subscribe(watcher.derived<number>('seats'), remote => {
      const held = heldOf(remote)
      if (held !== undefined) seen.push(held.value)
    })

    await settle(2)
    assert.deepEqual(seen, [7])

    stop()
    watcher.close()
  })

  test('a tab from another build is refused by version, not left to fall apart', async () => {
    const line = localBroadcast()
    const seats = port(1, { name: 'seats' })
    const hub = busHub('station', line, { lease: false })
    until(hub.accept(channel => serve({ cells: { seats } }, channel, { schedule: atOnce })))

    // A tab of an older build: it greets without a version, as builds before
    // versions did.
    const old = postbox(line, 'old-tab')
    const answers: unknown[] = []
    until(old.listen((_from, body) => answers.push(body)))
    old.send('graph', { hello: true })
    await settle(2)

    assert.equal(answers.length, 1)
    assert.match(String((answers[0] as { why: string }).why), /protocol 1.*none/)
  })

  test('a tab of this build is served as before', async () => {
    const line = localBroadcast()
    const seats = port(4, { name: 'seats' })
    const hub = busHub('station', line, { lease: false })
    until(hub.accept(channel => serve({ cells: { seats } }, channel, { schedule: atOnce })))

    const watcher = link(busChannel('station', line, { keepAlive: false }))
    const seen: number[] = []
    const stop = subscribe(watcher.derived<number>('seats'), remote => {
      const held = heldOf(remote)
      if (held !== undefined) seen.push(held.value)
    })
    await settle(2)
    assert.deepEqual(seen, [4])

    stop()
    watcher.close()
  })
})
