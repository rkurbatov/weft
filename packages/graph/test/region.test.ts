import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  attachProbe,
  derived,
  owned,
  port,
  quietly,
  region,
  regionName,
  subscribe,
  watch,
} from '#graph'
import { outbox } from '#outbox'
import { memoryStore } from '#store'
import { supply } from '#remote'
import { held, until, wakings, world } from '#testkit'

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
        const feed = supply(
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

describe('the small words around a region', () => {
  test('owned registers a teardown with the region that is being built', () => {
    const gone: string[] = []
    const module = region('module', () => {
      owned(() => gone.push('mine'))
      return 1
    })

    assert.deepEqual(gone, [])
    module.dispose()
    assert.deepEqual(gone, ['mine'])
  })

  test('outside a region, owned has nobody to register with, and says nothing', () => {
    // Not an error on purpose: a module that can be built inside a region or on
    // its own should not have to ask which it is.
    assert.doesNotThrow(() => {
      owned(() => {})
    })
  })

  test('a name says where a node was born, nested regions and all', () => {
    let inner = ''
    const outer = region('page', () => {
      region('panel', () => {
        inner = regionName() ?? ''
        return 0
      })
      return 0
    })

    assert.equal(inner, 'page.panel', 'the path, not the last step')
    assert.equal(regionName(), undefined, 'and outside, no region at all')
    outer.dispose()
  })

  test('quietly hides a tick from the instruments, not from the graph', () => {
    // What it is for: an instrument writing into the graph — a journal keeping
    // its own tail, a panel counting renders — must not appear in its own
    // record. The graph itself notices the write like any other.
    const seats = port(1, { name: 'seats' })
    const seen: number[] = []
    const ticks: string[] = []
    until(
      watch(() => {
        seen.push(seats.get())
      }),
    )
    attachProbe({ tick: summary => ticks.push(summary.writes.map(w => w.node).join()) })
    until(() => {
      attachProbe(null)
    })

    seats.set(2)
    assert.deepEqual(seen, [1, 2])
    assert.deepEqual(ticks, ['seats'], 'an ordinary write shows up')

    quietly(() => {
      seats.set(3)
    })
    assert.deepEqual(seen, [1, 2, 3], 'the graph recomputed as always')
    assert.deepEqual(ticks, ['seats'], 'and the instruments saw nothing of it')
  })
})
