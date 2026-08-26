// What a view will and will not let a screen do.
//
// The compiler is the test: `@ts-expect-error` fails the build if the line
// below it turns out to be legal. Nothing runs here.
//
// A filtered or ordered view is a way of looking at rows somebody else owns.
// It used to come back typed as the whole feed, writing side and all, because
// that was the type at hand — so a filter could be handed rows, which compiled
// and then threw. Now the type says what the thing is.

import { test } from 'node:test'
import { live } from '#loom'
import type { Live, LiveView } from '#loom'

interface Task {
  readonly id: number
  readonly title: string
  readonly done: boolean
}

test('a view reads; only the feed itself takes rows', () => {
  const tasks: Live<Task> = live<Task>({ name: 'live.types.tasks', key: row => row.id })
  const mine: LiveView<Task> = tasks.only(row => !row.done)

  // Reading is the whole of what a view offers, and all of it is there.
  const reading = [mine.rows, mine.size, mine.count(), mine.sumBy(() => 1)]
  const deeper: LiveView<Task> = mine.only(row => row.title !== '')
  const ordered = mine.sortedBy((a, b) => a.id - b.id)

  // Never called: these lines exist for the compiler, and at run time they are
  // exactly the throw the type now prevents.
  const refused = (): void => {
    // @ts-expect-error — a view is not a source: rows go into the feed that owns them
    mine.take({ id: 1, title: 'one', done: false })

    // @ts-expect-error — nor are they taken out of a view
    mine.lose(1)

    // @ts-expect-error — nor fed to one
    mine.feed({ put: [] })

    // @ts-expect-error — nor replaced wholesale
    mine.reset([])
  }

  // The feed itself still does all four.
  tasks.take({ id: 1, title: 'one', done: false })
  tasks.lose(1)
  tasks.feed({ put: [] })
  tasks.reset([])

  void reading
  void deeper
  void ordered
  void refused
})
