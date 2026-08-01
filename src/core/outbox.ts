// The outbox. A command that reached for the world must survive the tab dying:
// it is written down before it is sent, carries an idempotency key so a repeat
// is not a second purchase, and leaves the book only when the world confirms.

import { cell, input } from './graph.ts'
import type { Readable } from './graph.ts'
import { KEEPING } from './keep.ts'
import type { Keeping } from './keep.ts'
import type { Store } from './store.ts'
import type { Timers } from './source.ts'

export type EntryState = 'waiting' | 'sending' | 'stuck'

export interface Entry {
  /** The idempotency key. The same one on every attempt, including after a reload. */
  readonly id: string
  readonly name: string
  readonly args: unknown
  /** When it was written down. */
  readonly at: number
  readonly attempts: number
  readonly state: EntryState
  readonly lastError?: string
}

export interface Handling {
  /** Put this on the request so a repeat is recognised as the same command. */
  readonly key: string
  readonly attempt: number
}

export type Handler = (args: never, handling: Handling) => Promise<void>

export interface OutboxOptions {
  key: string
  store: Store
  handlers: Record<string, Handler>
  /** Wait before a retry; doubles per attempt, capped by retryCap. */
  retry?: number
  retryCap?: number
  /** After this many failures the entry stops trying and waits for a person. */
  maxAttempts?: number
  /** Start held: nothing is sent until `resume()`. */
  paused?: boolean
  now?: () => number
  timers?: Timers
  newId?: () => string
  onStuck?: (entry: Entry) => void
}

export interface Outbox {
  /** Resolves when what a previous run left behind has been lifted off the disk. */
  readonly ready: Promise<void>
  /** Are writes of the book reaching the disk. `without` names the reason. */
  readonly keeping: Readable<Keeping>
  /** Everything not yet confirmed by the world, in the order it was written down. */
  readonly entries: Readable<readonly Entry[]>
  /** How many are still owed to the world. */
  readonly owed: Readable<number>
  /** Are any stuck waiting for a person. */
  readonly stuck: Readable<readonly Entry[]>
  /** Write a command down and send it. Resolves when it leaves the book; rejects if it gets stuck. */
  send(name: string, args: unknown): { id: string; done: Promise<void> }
  /** Try a stuck entry again. */
  again(id: string): void
  /** Drop an entry without sending it. */
  forget(id: string): void
  pause(): void
  resume(): void
  readonly paused: boolean
}

const wallClock: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

function randomId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (crypto?.randomUUID !== undefined) return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function mendBook(raw: unknown): Entry[] {
  if (!Array.isArray(raw)) return []
  // A run that died mid-flight left entries marked as sending; the world may or
  // may not have taken them, which is exactly what the idempotency key is for.
  // The store parted with a clone that nobody else holds, so the entries are
  // set right in place rather than copied.
  const entries = raw as Entry[]
  for (const entry of entries) {
    if (entry.state === 'sending') (entry as { state: EntryState }).state = 'waiting'
  }
  return entries
}

export function outbox(options: OutboxOptions): Outbox {
  const { key, store, handlers, retry = 1000, maxAttempts = 5, onStuck } = options
  const retryCap = options.retryCap ?? retry * 32
  const now = options.now ?? Date.now
  const timers = options.timers ?? wallClock
  const newId = options.newId ?? randomId

  const entries = input<readonly Entry[]>([], { name: `${key}.entries` })
  const keeping = input<Keeping>(KEEPING, { name: `${key}.keeping` })
  const waiting = new Map<string, { resolve: () => void; reject: (error: unknown) => void }>()
  let held = options.paused ?? false
  let timer: unknown = null
  let sending = false
  let lifted = false

  // One writer for the book. Versions coalesce while one is in flight: the disk
  // always ends on the latest book, and no write is ever lost between two.
  let pendingBook: readonly Entry[] | undefined
  let writing = false
  function drainBook(): void {
    if (writing || pendingBook === undefined) return
    const book = pendingBook
    pendingBook = undefined
    writing = true
    store.write(key, book).then(
      () => {
        writing = false
        keeping.set(KEEPING)
        drainBook()
      },
      (error: unknown) => {
        writing = false
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        keeping.set({ kind: 'without', reason })
        drainBook()
      },
    )
  }

  function write(next: readonly Entry[]): void {
    entries.set(next)
    // Before the old book is lifted, writing would bury it; the lift merges and
    // writes the whole of it instead.
    if (!lifted) return
    pendingBook = next
    drainBook()
  }

  function replace(id: string, change: (entry: Entry) => Entry): void {
    write(entries.peek().map(entry => (entry.id === id ? change(entry) : entry)))
  }

  function remove(id: string): void {
    write(entries.peek().filter(entry => entry.id !== id))
  }

  function backoff(attempt: number): number {
    return Math.min(retry * 2 ** Math.max(0, attempt - 1), retryCap)
  }

  function cancelTimer(): void {
    if (timer === null) return
    timers.clear(timer)
    timer = null
  }

  function later(delay: number): void {
    cancelTimer()
    timer = timers.set(() => {
      timer = null
      void pump()
    }, delay)
  }

  function settle(id: string, error?: unknown): void {
    const waiter = waiting.get(id)
    if (waiter === undefined) return
    waiting.delete(id)
    if (error === undefined) waiter.resolve()
    else waiter.reject(error)
  }

  /** Send the head of the book, one at a time: order is part of the promise. */
  async function pump(): Promise<void> {
    if (sending || held || !lifted) return
    const head = entries.peek().find(entry => entry.state !== 'stuck')
    if (head === undefined) return

    const handler = handlers[head.name]
    if (handler === undefined) {
      const stuckEntry: Entry = {
        ...head,
        state: 'stuck',
        lastError: `no handler for "${head.name}"`,
      }
      replace(head.id, () => stuckEntry)
      onStuck?.(stuckEntry)
      settle(head.id, new Error(stuckEntry.lastError))
      void pump()
      return
    }

    sending = true
    const attempt = head.attempts + 1
    replace(head.id, entry => ({ ...entry, state: 'sending', attempts: attempt }))
    try {
      await (handler as (args: unknown, handling: Handling) => Promise<void>)(head.args, {
        key: head.id,
        attempt,
      })
      remove(head.id)
      settle(head.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (attempt >= maxAttempts) {
        const stuckEntry: Entry = { ...head, attempts: attempt, state: 'stuck', lastError: message }
        replace(head.id, () => stuckEntry)
        onStuck?.(stuckEntry)
        settle(head.id, error)
      } else {
        replace(head.id, entry => ({ ...entry, state: 'waiting', lastError: message }))
        later(backoff(attempt))
      }
    } finally {
      sending = false
    }
    if (timer === null) void pump()
  }

  // Whatever a previous run left behind is owed to the world. It is lifted
  // first, and nothing is sent until it is: order is part of the promise, and
  // what was written down earlier goes out earlier.
  const ready = store
    .read(key)
    .then(raw => mendBook(raw))
    .catch((error: unknown) => {
      // The disk did not answer: nothing to lift, and the book is not landing.
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      keeping.set({ kind: 'without', reason })
      return [] as Entry[]
    })
    .then(book => {
      const newborn = entries.peek()
      lifted = true
      if (book.length > 0 || newborn.length > 0) write([...book, ...newborn])
      if (!held) void pump()
    })

  return {
    ready,
    keeping,
    entries,
    owed: cell(() => entries.get().filter(entry => entry.state !== 'stuck').length, {
      name: `${key}.owed`,
    }),
    stuck: cell<readonly Entry[]>(() => entries.get().filter(entry => entry.state === 'stuck'), {
      name: `${key}.stuck`,
      equal: (a, b) => a.length === b.length && a.every((entry, i) => entry === b[i]),
    }),

    send(name, args) {
      const id = newId()
      const entry: Entry = { id, name, args, at: now(), attempts: 0, state: 'waiting' }
      // Written down before it is sent: a death between the two loses nothing.
      write([...entries.peek(), entry])
      const done = new Promise<void>((resolve, reject) => {
        waiting.set(id, { resolve, reject })
      })
      // The caller may ignore `done`; a refusal is already reported through the
      // entry itself, so an ignored promise must not look like a lost error.
      done.catch(() => {})
      void pump()
      return { id, done }
    },

    again(id) {
      replace(id, entry =>
        entry.state === 'stuck' ? { ...entry, state: 'waiting', attempts: 0 } : entry,
      )
      void pump()
    },

    forget(id) {
      remove(id)
      settle(id, new Error('forgotten'))
    },

    pause() {
      held = true
      cancelTimer()
    },

    resume() {
      held = false
      void pump()
    },

    get paused() {
      return held
    },
  }
}
