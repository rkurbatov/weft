import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { derived, port, subscribe } from '#graph/graph/graph.ts'
import { outbox } from '#offline/outbox.ts'
import { region } from '#graph/graph/region.ts'
import { memoryStore } from '#offline/store.ts'
import { source } from '#async/source.ts'
import { held, wakings, world } from '../../../kit/index.ts'

describe('a region owns what is born inside it', () => {
  test('lets go of its watchers and cells in one move', () => {
    const outside = port(1)
    const woke = wakings()
    const box = held(
      region('mod', () => {
        const doubled = derived(() => outside.get() * 2, { name: 'doubled' })
        subscribe(doubled, woke.note)
        return doubled
      }),
    )

    outside.set(2)
    woke.is(1)
    assert.equal(box.value.name, 'mod.doubled', 'the region names its own')

    box.dispose()
    outside.set(3)
    woke.is(1, 'nobody is listening anymore')
  })

  test('stops the clock of a source born inside it', async () => {
    const clock = world()
    let asked = 0
    const box = held(
      region('mod', () => {
        const feed = source(
          () => {
            asked++
            return Promise.resolve(asked)
          },
          { name: 'feed', every: 50, timers: clock.timers, now: clock.now },
        )
        subscribe(feed.state, () => {})
        return feed
      }),
    )

    await clock.advance(1) // let the first answer land and set the clock
    assert.equal(asked, 1)
    await clock.advance(120)
    assert.ok(asked >= 2, 'it was alive and asking')

    const was = asked
    box.dispose()
    await clock.advance(500)
    assert.equal(asked, was, 'the clock is stopped, nothing asks again')
    assert.equal(clock.pending(), 0)
  })

  test('holds the book of an outbox born inside it', async () => {
    const clock = world()
    let sent = 0
    const box = held(
      region('mod', () =>
        outbox({
          key: 'k',
          store: memoryStore(),
          handlers: {
            // Always transient: the entry keeps returning to the clock.
            nudge: () => {
              sent++
              return Promise.reject(new Error('flaky'))
            },
          },
          retry: 20,
          timers: clock.timers,
          now: clock.now,
        }),
      ),
    )

    await box.value.ready
    box.value.send('nudge', {})
    await clock.advance(1)
    assert.ok(sent >= 1)

    const was = sent
    box.dispose()
    await clock.advance(1000)
    assert.equal(sent, was, 'held: nothing more goes out')
    assert.equal(clock.pending(), 0, 'and nothing stays on the clock')
    assert.equal(box.value.entries.peek().length, 1, 'the book keeps what is owed')
  })

  test('nest, and so do their names', () => {
    const box = held(region('app', () => region('board', () => derived(() => 1, { name: 'size' }))))
    assert.equal(box.value.value.name, 'app.board.size')
  })
})
