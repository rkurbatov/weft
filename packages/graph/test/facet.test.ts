import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { batch, derived, engineOf, facet, keep, port, subscribe, trace } from '#graph'
import type { Derived } from '#graph'
// Inside the package, so the test names the machinery it checks instead of
// hunting for it by the text of a symbol through two prototypes.
import { RELEASE } from '#graph/nodes.ts'

// The lifecycle of the primitive itself, without Loom on top of it: a cell that
// owns its sources only while somebody is actually reading it.

const releasesOf = <T>(cell: Derived<T>): (() => number) => {
  const real = (cell as unknown as Record<symbol, () => boolean>)[RELEASE]!
  let count = 0
  ;(cell as unknown as Record<symbol, unknown>)[RELEASE] = function (this: unknown) {
    count++
    return real.call(this)
  }
  return () => count
}

describe('a cell that lets go of what it read', () => {
  test('a bare read holds nothing and keeps nothing', () => {
    const source = port(1, { name: 'source' })
    let runs = 0
    const view = facet(() => {
      runs++
      return source.get()
    })

    view.peek()
    view.peek()
    assert.equal(runs, 2, 'nothing is kept for a reader who does not stay')
    assert.deepEqual(trace(view).reads, [], 'and nothing is held either')
    assert.equal(source.observed, false)
  })

  test('a bare get holds nothing and keeps nothing either', () => {
    // The same law as `peek`, run as its own path: the two reach the base read
    // by different routes, and a defect in one of them is invisible from the
    // other.
    const source = port(1, { name: 'source' })
    let runs = 0
    const view = facet(() => {
      runs++
      return source.get()
    })

    view.get()
    view.get()
    assert.equal(runs, 2)
    assert.deepEqual(trace(view).reads, [])
    assert.equal(source.observed, false)
  })

  test('a reader that stays is held for, and let go of when it goes', () => {
    const source = port(1, { name: 'source' })
    let runs = 0
    const view = facet(() => {
      runs++
      return source.get()
    })
    const reader = derived(() => view.get(), { name: 'reader' })

    reader.peek()
    assert.equal(runs, 1)
    assert.equal(trace(view).reads?.length, 1, 'the link is held while somebody reads it')
    assert.equal(source.observed, true)

    reader.peek()
    assert.equal(runs, 1, 'and an ordinary cached answer comes back')

    reader.dispose()
    assert.deepEqual(trace(view).reads, [])
    assert.equal(source.observed, false)
  })

  test('one read asks the release question once', () => {
    const source = port(1)
    const view = facet(() => source.get())
    const released = releasesOf(view)
    view.peek()
    assert.equal(released(), 1, 'peek goes to the base read, not around through get')
    const stop = subscribe(view, () => {})
    assert.equal(released(), 2, 'the tracked read asked once, and the answer was no')
    stop()
    assert.equal(released(), 3, 'and the reader leaving asked once more')
  })

  test('losing the last reader twice in one turn lets go once', () => {
    const source = port(1)
    const view = facet(() => source.get())
    let disposals = 0
    const real = view.dispose.bind(view)
    view.dispose = () => {
      disposals++
      real()
    }
    const first = derived(() => view.get())
    const second = derived(() => view.get())
    first.peek()

    batch(() => {
      first.dispose()
      second.peek()
      second.dispose()
    })
    assert.equal(disposals, 1, 'one release asked for, not one per crossing')
    second.dispose()
  })
})

describe('one node, one keeper', () => {
  test('a second owner is refused rather than quietly taking over the first', () => {
    const node = port(1)
    const first = { observationChanged: () => {} }
    const second = { observationChanged: () => {} }
    keep(node, first)
    keep(node, first) // the same one again is nothing at all
    assert.throws(() => keep(node, second), /already has somebody keeping it/)
    keep(node, undefined)
    keep(node, second) // and once it is free, it can be kept again
    keep(node, undefined)
  })
})

describe('a release asked for many times is queued once', () => {
  test('short-lived readers do not fill the queue with callbacks nobody needs', () => {
    const source = port(1)
    const view = facet(() => source.get())
    const core = engineOf(view)!
    const real = core.notice.bind(core)
    let queued = 0
    core.notice = (fn: () => void) => {
      queued++
      real(fn)
    }
    try {
      batch(() => {
        for (let i = 0; i < 1000; i++) {
          const reader = derived(() => view.get())
          reader.peek()
          reader.dispose()
        }
      })
    } finally {
      core.notice = real
    }
    // One release happening was never the whole promise: one callback standing
    // in the queue is the other half of it.
    assert.equal(queued, 1)
  })
})
