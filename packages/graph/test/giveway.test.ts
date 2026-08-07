// Giving the event loop a turn.
//
// The thing every long run needs between chunks, and the thing every long run
// used to write out by hand as a zero timeout — which browsers clamp to four
// milliseconds once the timeouts nest, so eighty chunks paid a third of a
// second for nothing.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { giveWay } from '#graph'
import { MessageChannel } from 'node:worker_threads'

describe('giving way', () => {
  test('the caller resumes after other work has had its turn', async () => {
    const order: string[] = []
    const waiting = (async () => {
      order.push('before')
      await giveWay()
      order.push('after')
    })()

    // Queued while the run is between chunks: a click, a message, a paint.
    setTimeout(() => order.push('someone else'), 0)
    await waiting
    await new Promise<void>(resolve => setTimeout(resolve, 5))

    // The point is not who comes first — it is that the other work got in at
    // all, which is exactly what a run that never yields prevents.
    assert.equal(order[0], 'before')
    assert.ok(order.includes('after'), 'the run carried on')
    assert.ok(order.indexOf('someone else') < order.indexOf('after') + 2, 'and it was let in')
  })

  test('a thousand turns are cheap enough to take between chunks', async () => {
    const started = performance.now()
    for (let i = 0; i < 1000; i++) await giveWay()
    const spent = performance.now() - started

    // A zero timeout costs about a millisecond a turn here; anything the
    // library picks has to be far under that or the yield eats the run.
    assert.ok(spent < 500, `a thousand turns took ${spent.toFixed(0)}ms`)
  })

  test('an abort raised while yielding is seen on the other side', async () => {
    const control = new AbortController()
    let sawIt = false

    const run = (async () => {
      for (let i = 0; i < 5; i++) {
        await giveWay()
        if (control.signal.aborted) {
          sawIt = true
          return
        }
      }
    })()

    control.abort()
    await run
    assert.equal(sawIt, true, 'which is the whole reason for yielding at all')
  })
})

describe('what giving way must not do', () => {
  test('a message queued while the run waits is heard before it resumes', async () => {
    // The reason this matters: a worker searching a corpus hears "stop" as a
    // message. A yield that puts the caller ahead of newly queued tasks —
    // `scheduler.yield()` does exactly that — means the message is never
    // heard, the run finishes work nobody wants, and cancelling silently does
    // nothing. It looked fine in Node and never worked in a browser.
    const order: string[] = []
    const { port1, port2 } = new MessageChannel()
    port1.addEventListener('message', () => order.push('message'))
    port1.start()

    const run = (async () => {
      for (let i = 0; i < 3; i++) {
        await giveWay()
        order.push(`chunk ${String(i)}`)
      }
    })()

    port2.postMessage(null)
    await run
    port1.close()
    port2.close()

    assert.ok(order.includes('message'), 'the message arrived at all')
    assert.ok(
      order.indexOf('message') < order.indexOf('chunk 2'),
      `the run overtook the message: ${order.join(' → ')}`,
    )
  })
})
