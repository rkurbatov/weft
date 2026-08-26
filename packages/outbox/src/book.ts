// The book itself: what is written down, and how it reaches the disk.
//
// One writer, and no reasoning about sending — that lives next door in the
// pump. Versions coalesce while a write is in flight, so the disk always ends
// on the latest book and no write is lost between two.
//
// Every write hands back a barrier: it settles when that state, or a newer one
// covering it, has been confirmed by the disk, and it fails when the disk
// refused. Without the barrier the pump cannot tell "written down" from "on
// its way", and the whole promise of the outbox rests on that difference.
//
// Nothing here knows about clocks, handlers or retries: a book can be tested
// with a disk and nothing else.

import { port } from '#graph'
import type { Port } from '#graph'
import { SAVING } from '#store'
import type { Saving } from '#store'
import type { Store } from '#store'

export type NoteState = 'waiting' | 'sending' | 'stuck' | 'done'

export interface Note {
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
  readonly state: NoteState
  readonly lastError?: string
  /** When the world confirmed it — only on retained 'done' entries. */
  readonly doneAt?: number
}

export interface Book {
  readonly entries: Port<readonly Note[]>
  readonly saving: Port<Saving>
  /** Settles when whatever a previous run left behind has been lifted. */
  readonly ready: Promise<void>
  /** Whether the old book has been lifted: before that, writing would bury it. */
  lifted(): boolean
  /**
   * Whether the old book could not be read. Nothing is lifted, sent or written
   * while this holds: unread is not empty, and what could not be read may be a
   * previous run's unsent work.
   */
  shut(): boolean
  /** Settles when this state, or a newer one covering it, is on the disk. */
  write(next: readonly Note[]): Promise<void>
  replace(id: string, change: (entry: Note) => Note): Promise<void>
  remove(id: string): Promise<void>
  /** Whether this entry is in the last state the disk confirmed. */
  confirmed(id: string): boolean
  /** A barrier for the latest state handed in, written or still on its way. */
  written(): Promise<void>
  /** Try the disk again with whatever it has not confirmed. */
  flush(): Promise<void>
  /** Read the old book again after a failed read. */
  reopen(): Promise<void>
}

/** Anything a previous run left that is not a book is not lifted at all. */
function mend(raw: unknown): Note[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (entry: unknown): entry is Note =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Note).id === 'string' &&
      typeof (entry as Note).name === 'string',
  )
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

export function book(key: string, store: Store, onLifted: () => void): Book {
  const entries = port<readonly Note[]>([], { name: `${key}.entries` })
  const saving = port<Saving>(SAVING, { name: `${key}.saving` })
  let up = false
  let closed = false

  // A whole book is one state, so states are numbered rather than compared:
  // the disk confirming version 7 confirms 5 and 6 with it, and everybody
  // waiting on any of the three is answered at once.
  let version = 0
  let landed = 0
  let landedIds = new Set<string>()
  let pending: readonly Note[] | undefined
  let pendingAt = 0
  let writing = false
  let waiters: Array<{ at: number; resolve: () => void; reject: (error: unknown) => void }> = []

  function answer(at: number, error?: unknown): void {
    const owed = waiters.filter(one => one.at <= at)
    if (owed.length === 0) return
    waiters = waiters.filter(one => one.at > at)
    for (const one of owed) {
      if (error === undefined) one.resolve()
      else one.reject(error)
    }
  }

  function barrier(at: number): Promise<void> {
    if (at <= landed) return Promise.resolve()
    const promise = new Promise<void>((resolve, reject) => {
      waiters.push({ at, resolve, reject })
    })
    // A caller may ignore the barrier — a refusal is already visible in
    // `saving` — so an ignored promise must not look like a lost error.
    promise.catch(() => {})
    return promise
  }

  function drain(): void {
    if (writing || pending === undefined) return
    const next = pending
    const at = pendingAt
    pending = undefined
    writing = true
    store.write(key, next).then(
      () => {
        writing = false
        landed = at
        landedIds = new Set(next.map(entry => entry.id))
        saving.set(SAVING)
        answer(at)
        drain()
      },
      (error: unknown) => {
        writing = false
        // The state stays owed to the disk. Dropping it here is how a refused
        // write used to vanish: the note lived on in memory, the disk kept the
        // stale book, and nothing ever tried again.
        if (pending === undefined) {
          pending = next
          pendingAt = at
        }
        saving.set({ ok: false, reason: reasonOf(error) })
        answer(at, error)
      },
    )
  }

  function write(next: readonly Note[]): Promise<void> {
    entries.set(next)
    version++
    const at = version
    // Before the old book is lifted, writing would bury it; the lift merges and
    // writes the whole of it instead, and this barrier settles with that write.
    if (up) {
      pending = next
      pendingAt = at
      drain()
    }
    return barrier(at)
  }

  function lift(): Promise<void> {
    return store.read(key).then(
      raw => {
        const older = mend(raw)
        const newborn = entries.peek()
        up = true
        closed = false
        if (older.length > 0 || newborn.length > 0) {
          void write([...older, ...newborn])
        } else {
          // An empty book the disk confirmed is a confirmed state: whatever
          // barriers were taken before the lift are answered by it.
          landed = version
          landedIds = new Set()
          answer(version)
        }
        onLifted()
      },
      (error: unknown) => {
        // The disk did not answer. What could not be read is not absent: a
        // previous run's unsent notes may be sitting under this very key. The
        // book stays shut — nothing is lifted, sent, or written over it until
        // a reopen succeeds.
        closed = true
        saving.set({ ok: false, reason: reasonOf(error) })
      },
    )
  }

  const ready = lift()

  return {
    entries,
    saving,
    ready,
    lifted: () => up,
    shut: () => closed,
    write,
    replace(id, change) {
      return write(entries.peek().map(entry => (entry.id === id ? change(entry) : entry)))
    },
    remove(id) {
      return write(entries.peek().filter(entry => entry.id !== id))
    },
    confirmed: id => landedIds.has(id),
    written: () => barrier(version),
    flush() {
      if (pending === undefined) return barrier(version)
      drain()
      return barrier(pendingAt)
    },
    reopen() {
      if (up) return Promise.resolve()
      return lift()
    },
  }
}
