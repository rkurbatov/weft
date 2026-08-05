// The book itself: what is written down, and how it reaches the disk.
//
// One writer, and no reasoning about sending — that lives next door in the
// pump. Versions coalesce while a write is in flight, so the disk always ends
// on the latest book and no write is lost between two.
//
// Nothing here knows about clocks, handlers or retries: a book can be tested
// with a disk and nothing else.

import { stored } from '#graph/graph/graph.ts'
import type { Stored } from '#graph/graph/graph.ts'
import { SAVING } from './keep.ts'
import type { Saving } from './keep.ts'
import type { Store } from './store.ts'

export type EntryState = 'waiting' | 'sending' | 'stuck' | 'done'

export interface Entry {
  /** The idempotency key. The same one on every attempt, including after a reload. */
  readonly id: string
  readonly name: string
  /**
   * Which lane this entry waits in. Order holds within a lane; lanes do not
   * wait for each other. Absent on entries written before lanes existed, and
   * on everything that never asked for one — they share the main lane.
   */
  readonly lane?: string
  readonly args: unknown
  /** When it was written down. */
  readonly at: number
  readonly attempts: number
  readonly state: EntryState
  readonly lastError?: string
  /** When the world confirmed it — only on retained 'done' entries. */
  readonly doneAt?: number
}

export interface Book {
  readonly entries: Stored<readonly Entry[]>
  readonly saving: Stored<Saving>
  /** Settles when whatever a previous run left behind has been lifted. */
  readonly ready: Promise<void>
  /** Whether the old book has been lifted: before that, writing would bury it. */
  lifted(): boolean
  write(next: readonly Entry[]): void
  replace(id: string, change: (entry: Entry) => Entry): void
  remove(id: string): void
}

/** Anything a previous run left that is not a book is not lifted at all. */
function mend(raw: unknown): Entry[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (entry: unknown): entry is Entry =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Entry).id === 'string' &&
      typeof (entry as Entry).name === 'string',
  )
}

export function book(key: string, store: Store, onLifted: () => void): Book {
  const entries = stored<readonly Entry[]>([], { name: `${key}.entries` })
  const saving = stored<Saving>(SAVING, { name: `${key}.saving` })
  let up = false

  let pending: readonly Entry[] | undefined
  let writing = false

  function drain(): void {
    if (writing || pending === undefined) return
    const next = pending
    pending = undefined
    writing = true
    store.write(key, next).then(
      () => {
        writing = false
        saving.set(SAVING)
        drain()
      },
      (error: unknown) => {
        writing = false
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        saving.set({ ok: false, reason })
        drain()
      },
    )
  }

  function write(next: readonly Entry[]): void {
    entries.set(next)
    // Before the old book is lifted, writing would bury it; the lift merges and
    // writes the whole of it instead.
    if (!up) return
    pending = next
    drain()
  }

  // Whatever a previous run left behind is owed to the world. It is lifted
  // first, and nothing is sent until it is: order is part of the promise, and
  // what was written down earlier goes out earlier.
  const ready = store
    .read(key)
    .then(raw => mend(raw))
    .catch((error: unknown) => {
      // The disk did not answer: nothing to lift, and the book is not landing.
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      saving.set({ ok: false, reason })
      return [] as Entry[]
    })
    .then(lifted => {
      const newborn = entries.peek()
      up = true
      if (lifted.length > 0 || newborn.length > 0) write([...lifted, ...newborn])
      onLifted()
    })

  return {
    entries,
    saving,
    ready,
    lifted: () => up,
    write,
    replace(id, change) {
      write(entries.peek().map(entry => (entry.id === id ? change(entry) : entry)))
    },
    remove(id) {
      write(entries.peek().filter(entry => entry.id !== id))
    },
  }
}
