// The border of a failure.
//
// A formula that throws used to leave its cell in a state nobody could name,
// and a watcher that threw took the rest of its round down with it — the
// queue had already been emptied, so its neighbours never woke. Both are
// answered here: a failure is a state of the node, like the state of a
// command, and a round is always carried to its end.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attachProbe, graph, subscribe } from '#weft'
import type { WaveSummary } from '#weft'

test('a failing formula is a state, not a wound: it runs once and heals itself', () => {
  const g = graph('app')
  const divisor = g.input(2)
  let runs = 0
  const half = g.cell(() => {
    runs++
    if (divisor.get() === 0) throw new Error('divide by zero')
    return 10 / divisor.get()
  })

  assert.equal(half.get(), 5)
  assert.equal(runs, 1)

  divisor.set(0)
  assert.throws(() => half.get(), /divide by zero/)
  assert.equal(half.broken, true)
  // Read again: the held failure is rethrown, the formula is not run afresh.
  assert.throws(() => half.get(), /divide by zero/)
  assert.equal(runs, 2)

  // The links read before the throw are still live, so fixing the source is
  // the whole of the cure — nothing to reset by hand.
  divisor.set(5)
  assert.equal(half.get(), 2)
  assert.equal(half.broken, false)

  g.dispose()
})

test('a broken cell is heard by whoever reads it', () => {
  const g = graph('app')
  const divisor = g.input(2)
  const half = g.cell(() => {
    if (divisor.get() === 0) throw new Error('divide by zero')
    return 10 / divisor.get()
  })

  const seen: Array<number | string> = []
  g.watch(() => {
    try {
      seen.push(half.get())
    } catch {
      seen.push('broken')
    }
  })

  assert.deepEqual(seen, [5])
  divisor.set(0)
  assert.deepEqual(seen, [5, 'broken'])
  divisor.set(1)
  assert.deepEqual(seen, [5, 'broken', 10])

  g.dispose()
})

test('one watcher falling does not put its neighbours to sleep', () => {
  const caught: unknown[] = []
  const g = graph('app', { onError: error => caught.push(error) })
  const seats = g.input(1)
  const woke: string[] = []

  g.watch(() => {
    seats.get()
    woke.push('first')
  })
  g.watch(() => {
    if (seats.get() > 1) throw new Error('the middle one fell')
    woke.push('middle')
  })
  g.watch(() => {
    seats.get()
    woke.push('last')
  })
  woke.length = 0

  seats.set(2)
  // The one that fell is reported; the ones after it in the same round woke.
  assert.deepEqual(woke, ['first', 'last'])
  assert.equal(caught.length, 1)
  assert.match(String(caught[0]), /the middle one fell/)

  // And the graph takes the next write as if nothing had happened.
  woke.length = 0
  seats.set(1)
  assert.deepEqual(woke, ['first', 'middle', 'last'])

  g.dispose()
})

test('every failure of a wave is reported, not just the first', () => {
  const caught: unknown[] = []
  const g = graph('app', { onError: error => caught.push(error) })
  const seats = g.input(1)

  for (const name of ['a', 'b', 'c'])
    g.watch(() => {
      if (seats.get() > 1) throw new Error(`fell: ${name}`)
    })

  seats.set(2)
  assert.equal(caught.length, 3)
  assert.deepEqual(caught.map(String).toSorted(), [
    'Error: fell: a',
    'Error: fell: b',
    'Error: fell: c',
  ])

  g.dispose()
})

test('without a handler the failure is thrown — after the round, not instead of it', () => {
  const g = graph('app')
  const seats = g.input(1)
  const woke: string[] = []

  g.watch(() => {
    if (seats.get() > 1) throw new Error('loud')
    woke.push('faller')
  })
  const stop = subscribe(seats, () => woke.push('neighbour'))
  woke.length = 0

  assert.throws(() => seats.set(2), /loud/)
  // The neighbour was woken all the same: the throw came after the round.
  assert.deepEqual(woke, ['neighbour'])

  stop()
  g.dispose()
})

test('a failure is named in the wave, so the journal can point at it', () => {
  const waves: WaveSummary[] = []
  const g = graph('app')
  attachProbe({ wave: (summary: WaveSummary) => waves.push(summary) }, g)

  const divisor = g.input(2)
  const half = g.cell(
    () => {
      if (divisor.get() === 0) throw new Error('divide by zero')
      return 10 / divisor.get()
    },
    { name: 'half' },
  )
  g.watch(() => {
    try {
      half.get()
    } catch {
      /* the screen shows the failure; the wave records it */
    }
  })

  divisor.set(0)
  const last = waves.at(-1)
  assert.deepEqual(last?.failed, ['half'])

  attachProbe(null, g)
  g.dispose()
})
