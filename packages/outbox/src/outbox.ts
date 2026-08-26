// The outbox. A command that reached for the world must survive the tab dying:
// it is written down before it is sent, carries an idempotency key so a repeat
// is not a second purchase, and leaves the book only when the world confirms.

import { derived } from '#graph'
import { book as openBook } from './book.ts'
import { schedule } from './schedule.ts'
import { owned } from '#graph'
import type { Fault } from '#remote'

import type { Handling, Note, Outbox, OutboxOptions } from './contract.ts'

export type { Handler, Handling, Note, NoteState, Outbox, OutboxOptions } from './contract.ts'

/** The lane everything shares unless it asks for one of its own. */
const MAIN = 'main'

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

  const laneOptions = {
    retry,
    cap: options.retryCap ?? retry * 32,
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    ...(options.paused === undefined ? {} : { paused: options.paused }),
  }
  /**
   * One clock per lane, born when the lane is first used. Order holds within a
   * lane; a lane waiting out a refusal does not hold up the others — an
   * analytics call must not delay the saving of a document.
   */
  const clocks = new Map<string, ReturnType<typeof schedule>>()
  let held = laneOptions.paused ?? false
  const clockOf = (lane: string): ReturnType<typeof schedule> => {
    const standing = clocks.get(lane)
    if (standing !== undefined) return standing
    const made = schedule({ ...laneOptions, paused: held })
    clocks.set(lane, made)
    return made
  }
  const laneOf = (entry: Note): string => entry.lane ?? MAIN

  /**
   * The disk is one, so its trouble is one clock, not one per lane. A refused
   * write or an unreadable book is not a lane waiting out a server — it is
   * everything waiting for the shelf itself, and until the shelf answers
   * nothing may be sent.
   */
  const disk = schedule({ ...laneOptions, paused: held })
  let diskTries = 0

  function afterDiskTrouble(): void {
    if (held) return
    diskTries++
    disk.after(disk.backoff(diskTries), () => {
      const again = pages.shut() ? pages.reopen() : pages.flush()
      void again.then(
        () => {
          // A reopen answers whether or not it succeeded; `shut` is the verdict.
          if (pages.shut()) {
            afterDiskTrouble()
            return
          }
          diskTries = 0
          pumpAll()
        },
        () => afterDiskTrouble(),
      )
    })
  }

  const pages = openBook(key, store, () => {
    if (!held) pumpAll()
  })
  // A book that could not be read is not a book that is empty. Nothing is sent
  // over it; the only thing to do is ask the disk again.
  void pages.ready.then(() => {
    if (pages.shut()) afterDiskTrouble()
  })
  const { entries, saving } = pages
  const waiting = new Map<
    string,
    { resolve: () => void; reject: (error: unknown) => void; promise?: Promise<void> }
  >()
  /** Lanes with something in flight right now. */
  const sending = new Set<string>()

  function settle(id: string, error?: unknown): void {
    const waiter = waiting.get(id)
    if (waiter === undefined) return
    waiting.delete(id)
    if (error === undefined) waiter.resolve()
    else waiter.reject(error)
  }

  /** Try this lane's head again after a wait: the only thing touching a clock. */
  function retryLater(lane: string, delay: number): void {
    clockOf(lane).after(delay, () => void pump(lane))
  }

  /** Wake every lane that has something owed. */
  function pumpAll(): void {
    const lanes = new Set<string>()
    for (const entry of entries.peek()) {
      if (entry.state !== 'stuck' && entry.state !== 'done') lanes.add(laneOf(entry))
    }
    for (const lane of lanes) void pump(lane)
  }

  /** Send the head of the book, one at a time: order is part of the promise. */
  async function pump(lane: string = MAIN): Promise<void> {
    if (sending.has(lane) || held || !pages.lifted()) return
    // The head of the lane is the head — a stuck one included. Skipping it to
    // send whatever stands behind breaks the very order the lane promises: a
    // Create stuck and an Update sent lands an edit for a thing the server
    // never saw. A stuck head stops its lane until a person answers with
    // `again` or `forget`; other lanes are other stories and keep moving.
    const head = entries.peek().find(entry => laneOf(entry) === lane && entry.state !== 'done')
    if (head === undefined || head.state === 'stuck') return

    // Written down BEFORE it is sent — and written down means the disk said so,
    // not that a write was started. Between the two there is a window in which
    // a dying tab leaves the world changed with no record of it and no
    // idempotency key to repeat by; that window is the one thing an outbox
    // exists to close. Sending is held here rather than only at `send`, because
    // the head after a finished send is the next entry, whose own write may
    // still be travelling.
    if (!pages.confirmed(head.id)) {
      void pages.written().then(
        () => {
          if (pages.confirmed(head.id)) void pump(lane)
          // The disk moved on without it: the shelf, not the lane, is the
          // trouble, and it is tried again on the disk's own clock.
          else afterDiskTrouble()
        },
        () => afterDiskTrouble(),
      )
      return
    }

    const handler = handlers[head.name]
    if (handler === undefined) {
      const stuckEntry: Note = {
        ...head,
        state: 'stuck',
        lastError: `no handler for "${head.name}"`,
      }
      pages.replace(head.id, () => stuckEntry)
      onStuck?.(stuckEntry)
      settle(head.id, new Error(stuckEntry.lastError))
      void pump(lane)
      return
    }

    sending.add(lane)
    const attempt = head.attempts + 1
    pages.replace(head.id, entry => ({ ...entry, state: 'sending', attempts: attempt }))
    try {
      await (handler as (args: unknown, handling: Handling) => Promise<void>)(head.args, {
        key: head.id,
        attempt,
      })
      // With `retain`, success does not remove the entry — it marks it done
      // and leaves it laid over the base. Removing it here is the classic
      // optimistic-UI flicker: the server said yes, the local note vanishes,
      // but the base feed has not refetched yet, so the screen falls back to
      // the OLD state for a beat and then jumps forward again. A done entry
      // keeps covering that gap until `absorb(stamp)` says the base itself
      // is from after the confirmation — only then is there nothing left to
      // cover.
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
        retryLater(lane, clockOf(lane).backoff(head.attempts + 1))
      } else if (attempt >= maxAttempts) {
        const stuckEntry: Note = { ...head, attempts: attempt, state: 'stuck', lastError: message }
        pages.replace(head.id, () => stuckEntry)
        onStuck?.(stuckEntry)
        settle(head.id, error)
      } else {
        pages.replace(head.id, entry => ({ ...entry, state: 'waiting', lastError: message }))
        retryLater(lane, clockOf(lane).backoff(attempt))
      }
    } finally {
      sending.delete(lane)
    }
    if (!clockOf(lane).waiting()) void pump(lane)
  }

  // A region taking this outbox down holds the book: entries stay written,
  // nothing more is sent, no timer stays on the clock.
  owned(() => {
    held = true
    disk.hold()
    for (const clock of clocks.values()) clock.hold()
  })

  return {
    ready: pages.ready,
    saving,
    entries,
    active: derived<readonly Note[]>(() => entries.get().filter(entry => entry.state !== 'stuck'), {
      name: `${key}.active`,
      equal: (a, b) => a.length === b.length && a.every((entry, i) => entry === b[i]),
    }),
    owed: derived(
      () => entries.get().filter(entry => entry.state !== 'stuck' && entry.state !== 'done').length,
      { name: `${key}.owed` },
    ),
    stuck: derived<readonly Note[]>(() => entries.get().filter(entry => entry.state === 'stuck'), {
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
      const lane = opts?.lane ?? MAIN
      const entry: Note = {
        id,
        name,
        args,
        at: now(),
        attempts: 0,
        state: 'waiting',
        ...(lane === MAIN ? {} : { lane }),
      }
      // Written down before it is sent: a death between the two loses nothing.
      const written = pages.write([...entries.peek(), entry])
      let arm: { resolve: () => void; reject: (error: unknown) => void } | undefined
      const done = new Promise<void>((resolve, reject) => {
        arm = { resolve, reject }
      })
      if (arm !== undefined) waiting.set(id, { ...arm, promise: done })
      // The caller may ignore `done`; a refusal is already reported through the
      // entry itself, so an ignored promise must not look like a lost error.
      done.catch(() => {})
      // The refusal of a disk is not the refusal of a server: the intent stands
      // and stays owed, `saving` says why nothing is moving, and the write is
      // tried again on the disk's clock. What must not happen is the send.
      void written.then(
        () => void pump(lane),
        () => afterDiskTrouble(),
      )
      return { id, done }
    },

    absorb(before) {
      // The timestamp comparison is the whole trick: a done note leaves only
      // when the base snapshot is younger than its confirmation. A base
      // fetched before the mutation landed still shows the old world and
      // still needs the note over it; one fetched after already contains the
      // change, and keeping the note past that point is merely harmless.
      const book = entries.peek()
      const kept = book.filter(
        entry => entry.state !== 'done' || entry.doneAt === undefined || entry.doneAt > before,
      )
      if (kept.length !== book.length) pages.write(kept)
    },

    note(name, args) {
      if (!retain) throw new Error(`weft: outbox "${key}" needs retain for note()`)
      const id = newId()
      const entry: Note = {
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
      const revived = entries.peek().find(one => one.id === id)
      if (revived !== undefined) void pump(laneOf(revived))
    },

    forget(id) {
      const entry = entries.peek().find(one => one.id === id)
      pages.remove(id)
      if (entry !== undefined) {
        onDiscarded?.({ ...entry, lastError: 'discarded by hand' })
        // Its lane may have been waiting behind it.
        void pump(laneOf(entry))
      }
      settle(id, new Error(`discarded by hand: ${id}`))
    },

    pause() {
      held = true
      disk.hold()
      for (const clock of clocks.values()) clock.hold()
    },

    resume() {
      held = false
      disk.release()
      for (const clock of clocks.values()) clock.release()
      if (pages.shut()) afterDiskTrouble()
      pumpAll()
    },

    get paused() {
      return held
    },
  }
}
