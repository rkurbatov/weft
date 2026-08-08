// The React seams' working part, tested without a renderer: arrivalOf carries
// the demand and the promise; the hooks over it are thin adapters checked by
// the compiler and exercised by the demos.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { source } from '#weft'
import { arrivalOf } from '#loom/react'
import { world } from '#testkit'

describe('the React seam', () => {
  test('asking for the arrival is what starts the load; the demand leaves with it', async () => {
    const clock = world()
    let asked = 0
    const feed = source(
      () => {
        asked++
        return Promise.resolve('answer')
      },
      { name: 'feed', timers: clock.timers, now: clock.now },
    )
    assert.equal(feed.demanded, false)

    const first = arrivalOf(feed)
    const second = arrivalOf(feed)
    assert.equal(first, second) // one promise per unsettled source
    assert.equal(feed.demanded, true) // the asking itself is the demand

    await clock.advance(1)
    await first
    assert.equal(asked, 1)
    assert.equal(feed.demanded, false) // nothing lingers once it landed

    await arrivalOf(feed) // already held: resolves at once, asks nothing
    assert.equal(asked, 1)
  })

  test('the first refusal settles the arrival', async () => {
    const clock = world()
    const feed = source(() => Promise.reject(new Error('down')), {
      name: 'sour',
      timers: clock.timers,
      now: clock.now,
    })
    const landing = arrivalOf(feed)
    await clock.advance(1)
    await landing // resolves — the throw itself is the hook's business, not the promise's
    assert.equal(feed.state.peek().kind, 'failed')
    assert.equal(feed.demanded, false)
  })
})
