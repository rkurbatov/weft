// What an outbox is, said once.
//
// The handler's view of an attempt, the passport, and the surface. Apart from
// the pump because three files implement pieces of the same promise — the
// book writes, the schedule waits, the pump decides — and a promise read from
// inside one of them is a promise nobody reads.

import type { Readable } from '#graph'
import type { Timers } from '#graph/time.ts'
import type { Fault } from '#remote'
import type { Note, NoteState } from './book.ts'
import type { Store } from './store.ts'
import type { Saving } from './keep.ts'

export type { Note, NoteState }

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
  onStuck?: (entry: Note) => void
  /** Told when a permanent or rejected fault discards the entry at once: the
   *  world said a no that retrying will not change. Discarding leaves a trace —
   *  the entry arrives with its last error; silence is not an option here. */
  onRefused?: (entry: Note) => void
  /** Told when an entry is dropped by hand. Discarding goes through the same
   *  door as success — with a mark and a trace, never a silent erasure. */
  onDiscarded?: (entry: Note) => void
}

export interface Outbox {
  /** Resolves when what a previous run left behind has been lifted off the disk. */
  readonly ready: Promise<void>
  /** Are writes of the book landing. `ok: false` names the reason. */
  readonly saving: Readable<Saving>
  /** The whole book in the order it was written: owed, stuck, and — with
   *  `retain` — confirmed entries the base has not absorbed yet. */
  readonly entries: Readable<readonly Note[]>
  /** What should lay over the base: everything but the stuck. */
  readonly active: Readable<readonly Note[]>
  /** How many are still owed to the world. */
  readonly owed: Readable<number>
  /** Are any stuck waiting for a person. */
  readonly stuck: Readable<readonly Note[]>
  /** Write a command down and send it. Resolves when it leaves the book; rejects if it gets stuck. */
  /** With opts.key the caller names the note: a repeat under the same key
   *  returns the very note already in the book instead of writing a second —
   *  the law of the key on this boundary. */
  send(
    name: string,
    args: unknown,
    opts?: { key?: string; lane?: string },
  ): { id: string; done: Promise<void> }
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
