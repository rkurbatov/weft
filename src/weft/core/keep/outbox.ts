// The outbox. A command that reached for the world must survive the tab dying:
// it is written down before it is sent, carries an idempotency key so a repeat
// is not a second purchase, and leaves the book only when the world confirms.

import { cell } from '../graph/graph.ts'
import { book as openBook } from './book.ts'
import type { Entry } from './book.ts'
import { schedule } from './schedule.ts'
import { owned } from '../graph/region.ts'
import type { Readable } from '../graph/graph.ts'
import type { Fault } from '../remote/remote.ts'
import type { Store } from './store.ts'
import type { Timers } from '../graph/time.ts'
import type { Saving } from './keep.ts'

export type { Entry, EntryState } from './book.ts'

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
  /** After this many REFUSALS the entry stops trying and waits for a person.
   *  An unknown outcome — sent, no answer — never counts: the ask carries its
   *  idempotency key, so it is repeated as a matter of course; a blinking
   *  network must not bury a living entry. */
  maxAttempts?: number
  /** Name the kind of trouble a handler threw. Default: Unknown-shaped errors
   *  are unknown, everything else transient. */
  classify?: (error: unknown) => Fault
  /**
   * Keep a confirmed entry in the book, marked 'done', until absorb() says the
   * base has caught up. This is the third state of a note: confirmed but not
   * yet absorbed — dropping it early would flash the screen backwards.
   */
  retain?: boolean
  /** Start held: nothing is sent until `resume()`. */
  paused?: boolean
  now?: () => number
  timers?: Timers
  newId?: () => string
  onStuck?: (entry: Entry) => void
  /** Told when a permanent or rejected fault discards the entry at once: the
   *  world said a no that retrying will not change. Discarding leaves a trace —
   *  the entry arrives with its last error; silence is not an option here. */
  onRefused?: (entry: Entry) => void
  /** Told when an entry is dropped by hand. Discarding goes through the same
   *  door as success — with a mark and a trace, never a silent erasure. */
  onDiscarded?: (entry: Entry) => void
}

export interface Outbox {
  /** Resolves when what a previous run left behind has been lifted off the disk. */
  readonly ready: Promise<void>
  /** Are writes of the book landing. `ok: false` names the reason. */
  readonly saving: Readable<Saving>
  /** The whole book in the order it was written: owed, stuck, and — with
   *  `retain` — confirmed entries the base has not absorbed yet. */
  readonly entries: Readable<readonly Entry[]>
  /** What should lay over the base: everything but the stuck. */
  readonly active: Readable<readonly Entry[]>
  /** How many are still owed to the world. */
  readonly owed: Readable<number>
  /** Are any stuck waiting for a person. */
  readonly stuck: Readable<readonly Entry[]>
  /** Write a command down and send it. Resolves when it leaves the book; rejects if it gets stuck. */
  /** With opts.key the caller names the note: a repeat under the same key
   *  returns the very note already in the book instead of writing a second —
   *  the law of the key on this boundary. */
  send(name: string, args: unknown, opts?: { key?: string }): { id: string; done: Promise<void> }
  /** Write down a fait accompli: confirmed elsewhere, never sent. Born 'done',
   *  it lays over the base until absorb() says the base has caught up.
   *  Meaningful with `retain`; without it the base has nothing to catch up to,
   *  and the note is refused loudly rather than dropped quietly. */
  note(name: string, args: unknown): { id: string }
  /** The base has caught up to this moment: retained entries confirmed at or
   *  before it are absorbed and leave the book. */
  absorb(before: number): void
  /** Try a stuck entry again. */
  again(id: string): void
  /** Drop an entry without sending it. */
  forget(id: string): void
  pause(): void
  resume(): void
  readonly paused: boolean
}

function randomId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (crypto?.randomUUID !== undefined) return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function outbox(options: OutboxOptions): Outbox {
  const {
    key,
    store,
    handlers,
    retry = 1000,
    maxAttempts = 5,
    retain = false,
    onStuck,
    onRefused,
    onDiscarded,
  } = options
  const classify =
    options.classify ??
    ((error: unknown): Fault =>
      error instanceof Error && (error.name === 'Unknown' || error.name === 'UnknownOutcome')
        ? 'unknown'
        : 'transient')
  const now = options.now ?? Date.now
  const newId = options.newId ?? randomId

  const clock = schedule({
    retry,
    cap: options.retryCap ?? retry * 32,
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    ...(options.paused === undefined ? {} : { paused: options.paused }),
  })
  const pages = openBook(key, store, () => {
    if (!clock.held()) void pump()
  })
  const { entries, saving } = pages
  const waiting = new Map<
    string,
    { resolve: () => void; reject: (error: unknown) => void; promise?: Promise<void> }
  >()
  let sending = false

  function settle(id: string, error?: unknown): void {
    const waiter = waiting.get(id)
    if (waiter === undefined) return
    waiting.delete(id)
    if (error === undefined) waiter.resolve()
    else waiter.reject(error)
  }

  /** Try the head again after a wait: the only thing that touches the clock. */
  function retryLater(delay: number): void {
    clock.after(delay, () => void pump())
  }

  /** Send the head of the book, one at a time: order is part of the promise. */
  async function pump(): Promise<void> {
    if (sending || clock.held() || !pages.lifted()) return
    const head = entries.peek().find(entry => entry.state !== 'stuck' && entry.state !== 'done')
    if (head === undefined) return

    const handler = handlers[head.name]
    if (handler === undefined) {
      const stuckEntry: Entry = {
        ...head,
        state: 'stuck',
        lastError: `no handler for "${head.name}"`,
      }
      pages.replace(head.id, () => stuckEntry)
      onStuck?.(stuckEntry)
      settle(head.id, new Error(stuckEntry.lastError))
      void pump()
      return
    }

    sending = true
    const attempt = head.attempts + 1
    pages.replace(head.id, entry => ({ ...entry, state: 'sending', attempts: attempt }))
    try {
      await (handler as (args: unknown, handling: Handling) => Promise<void>)(head.args, {
        key: head.id,
        attempt,
      })
      if (retain) pages.replace(head.id, entry => ({ ...entry, state: 'done', doneAt: now() }))
      else pages.remove(head.id)
      settle(head.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const fault = classify(error)
      if (fault === 'permanent' || fault === 'rejected') {
        // The world meaningfully said no; repeating will not change it. The
        // entry leaves at once — through a door with a trace, never silently.
        pages.remove(head.id)
        onRefused?.({ ...head, attempts: attempt, state: 'stuck', lastError: message })
        settle(head.id, error)
      } else if (fault === 'unknown') {
        // Sent, no answer. The world may have taken it, which is exactly what
        // the idempotency key is for — so the entry is repeated as a matter of
        // course and the poison count is not touched: a blinking network must
        // not bury a living entry.
        pages.replace(head.id, entry => ({
          ...entry,
          state: 'waiting',
          attempts: head.attempts,
          lastError: message,
        }))
        retryLater(clock.backoff(head.attempts + 1))
      } else if (attempt >= maxAttempts) {
        const stuckEntry: Entry = { ...head, attempts: attempt, state: 'stuck', lastError: message }
        pages.replace(head.id, () => stuckEntry)
        onStuck?.(stuckEntry)
        settle(head.id, error)
      } else {
        pages.replace(head.id, entry => ({ ...entry, state: 'waiting', lastError: message }))
        retryLater(clock.backoff(attempt))
      }
    } finally {
      sending = false
    }
    if (!clock.waiting()) void pump()
  }

  // A region taking this outbox down holds the book: entries stay written,
  // nothing more is sent, no timer stays on the clock.
  owned(() => clock.hold())

  return {
    ready: pages.ready,
    saving,
    entries,
    active: cell<readonly Entry[]>(() => entries.get().filter(entry => entry.state !== 'stuck'), {
      name: `${key}.active`,
      equal: (a, b) => a.length === b.length && a.every((entry, i) => entry === b[i]),
    }),
    owed: cell(
      () => entries.get().filter(entry => entry.state !== 'stuck' && entry.state !== 'done').length,
      { name: `${key}.owed` },
    ),
    stuck: cell<readonly Entry[]>(() => entries.get().filter(entry => entry.state === 'stuck'), {
      name: `${key}.stuck`,
      equal: (a, b) => a.length === b.length && a.every((entry, i) => entry === b[i]),
    }),

    send(name, args, opts) {
      const id = opts?.key ?? newId()
      const known = entries.peek().find(entry => entry.id === id)
      if (known !== undefined) {
        // The key names a note already written: answer with that very note.
        if (known.state === 'done') return { id, done: Promise.resolve() }
        const pending = waiting.get(id)
        if (pending?.promise !== undefined) return { id, done: pending.promise }
        let arm: { resolve: () => void; reject: (error: unknown) => void } | undefined
        const done = new Promise<void>((resolve, reject) => {
          arm = { resolve, reject }
        })
        if (arm !== undefined) waiting.set(id, { ...arm, promise: done })
        done.catch(() => {})
        return { id, done }
      }
      const entry: Entry = { id, name, args, at: now(), attempts: 0, state: 'waiting' }
      // Written down before it is sent: a death between the two loses nothing.
      pages.write([...entries.peek(), entry])
      let arm: { resolve: () => void; reject: (error: unknown) => void } | undefined
      const done = new Promise<void>((resolve, reject) => {
        arm = { resolve, reject }
      })
      if (arm !== undefined) waiting.set(id, { ...arm, promise: done })
      // The caller may ignore `done`; a refusal is already reported through the
      // entry itself, so an ignored promise must not look like a lost error.
      done.catch(() => {})
      void pump()
      return { id, done }
    },

    absorb(before) {
      const book = entries.peek()
      const kept = book.filter(
        entry => entry.state !== 'done' || entry.doneAt === undefined || entry.doneAt > before,
      )
      if (kept.length !== book.length) pages.write(kept)
    },

    note(name, args) {
      if (!retain) throw new Error(`weft: outbox "${key}" needs retain for note()`)
      const id = newId()
      const entry: Entry = {
        id,
        name,
        args,
        at: now(),
        attempts: 0,
        state: 'done',
        doneAt: now(),
      }
      pages.write([...entries.peek(), entry])
      return { id }
    },

    again(id) {
      pages.replace(id, entry =>
        entry.state === 'stuck' ? { ...entry, state: 'waiting', attempts: 0 } : entry,
      )
      void pump()
    },

    forget(id) {
      const entry = entries.peek().find(one => one.id === id)
      pages.remove(id)
      if (entry !== undefined) onDiscarded?.({ ...entry, lastError: 'discarded by hand' })
      settle(id, new Error(`discarded by hand: ${id}`))
    },

    pause() {
      clock.hold()
    },

    resume() {
      clock.release()
      void pump()
    },

    get paused() {
      return clock.held()
    },
  }
}
