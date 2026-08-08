// A table that lives in a worker, and a window onto it.
//
// The point of the page: a hundred thousand rows are held on the other side of
// a wire, and what crosses is the twenty rows a person can see. Scrolling
// moves the window; the window is a cell like any other, so moving it is a
// write and the new rows arrive the way any value does.
//
// The draft of an edit is deliberately not a field of the row. A row scrolled
// out of the window is gone from this side, and a draft kept inside it would
// go with it — which is the bug this page exists to not have.

import { cell } from '#loom'
import type { Port, Watchable } from '#loom'
import { table } from '#weft'
import type { Key, SourceTable } from '#weft'

export interface Task {
  readonly id: number
  readonly title: string
  readonly owner: string
  readonly done: boolean
}

const OWNERS = ['ann', 'bob', 'cal', 'dee', 'eve', 'fay', 'gus', 'hal']

/** The same hundred thousand rows every time. */
function seed(count: number): Task[] {
  const out: Task[] = []
  for (let id = 0; id < count; id++) {
    out.push({
      id,
      title: `task ${String(id).padStart(6, '0')}`,
      owner: OWNERS[id % OWNERS.length] ?? 'ann',
      done: id % 7 === 0,
    })
  }
  return out
}

export interface Desk {
  readonly rows: SourceTable<Task>
  /** How many rows there are in all — the scrollbar needs it, the panel does not hold them. */
  readonly size: Watchable<number>
  /** First visible row, written by whoever is scrolling. */
  readonly from: Port<number>
  /** How many rows fit on screen. */
  readonly span: Port<number>
  /** Exactly the visible rows, and nothing else. */
  readonly window: Watchable<readonly Task[]>
  /** Drafts by row key: an edit in progress survives its row leaving the window. */
  readonly draft: (key: Key) => Port<string>
}

export function desk(count = 100_000): Desk {
  const rows = table<Task>({ key: r => r.id as Key, name: 'tasks' })
  rows.put(seed(count))

  const from = cell(0, { name: 'from' })
  const span = cell(20, { name: 'span' })
  const ordered = rows.orderBy((a, b) => a.id - b.id, 'byId')

  const window = cell(() => ordered.slice(from.get(), from.get() + span.get()).get(), {
    name: 'window',
  })

  const drafts = new Map<Key, Port<string>>()
  const draft = (key: Key): Port<string> => {
    const known = drafts.get(key)
    if (known !== undefined) return known
    const made = cell('', { name: `draft.${String(key)}` })
    drafts.set(key, made)
    return made
  }

  return { rows, size: rows.size, from, span, window, draft }
}
