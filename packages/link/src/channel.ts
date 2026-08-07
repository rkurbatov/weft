// The wire between a graph and whoever is watching it. Two functions — send and
// listen — and a handful of messages. In one process the two ends are a pair of
// functions; in a browser they are a worker; nothing above this layer can tell.

import { wallClock } from '#graph'
import type { Timers } from '#graph'

export interface Channel {
  send(message: unknown): void
  /** Returns the way to stop listening. */
  listen(handler: (message: unknown) => void): () => void
  /** A channel that owns its transport closes it here; borrowed ones omit this. */
  close?(): void
}

export type ToGraph =
  | { readonly kind: 'watch'; readonly id: number; readonly cell: string; readonly key?: unknown }
  | { readonly kind: 'unwatch'; readonly id: number }
  | {
      readonly kind: 'call'
      readonly id: number
      readonly command: string
      readonly args: readonly unknown[]
    }
  /** Write into a published fact. Writing is allowed only into the declared. */
  | { readonly kind: 'write'; readonly fact: string; readonly value: unknown }
  /** Follow a published table: a snapshot first, then batches of changes. */
  | { readonly kind: 'follow'; readonly id: number; readonly table: string }
  | { readonly kind: 'unfollow'; readonly id: number }
  /**
   * Catch up from `since`.
   *
   * Sent when a batch was lost — the numbers do not run on — or after the
   * station came back up. The station answers with changes if it still
   * remembers them and with a fresh snapshot if it does not: a table that has
   * forgotten says so rather than pretending the sequence is unbroken.
   */
  | { readonly kind: 'catchUp'; readonly id: number; readonly since: number }

export type ToWatcher =
  /** The graph's side is up. Anyone watching should ask again — it knows nothing of what came before. */
  | { readonly kind: 'up' }
  | { readonly kind: 'values'; readonly changed: ReadonlyArray<{ id: number; value: unknown }> }
  | { readonly kind: 'done'; readonly id: number; readonly value: unknown }
  /**
   * Every row of a followed table, with its key, and the version they are as of.
   *
   * The key travels with the row because how a key is computed is a closure on
   * the station's side, and closures do not cross a wire. Without it the other
   * side could not tell which row a later change is about.
   */
  | {
      readonly kind: 'rows'
      readonly id: number
      readonly at: number
      readonly rows: readonly { readonly key: unknown; readonly row: unknown }[]
    }
  /**
   * What changed between two versions of a followed table.
   *
   * `from` is the version the receiver must already be at. If it is not — a
   * batch was lost — the receiver asks to catch up rather than applying
   * changes onto a state they were not computed against.
   */
  | {
      readonly kind: 'changed'
      readonly id: number
      readonly from: number
      readonly to: number
      readonly changes: readonly { readonly key: unknown; readonly next: unknown | null }[]
    }
  | { readonly kind: 'failed'; readonly id: number; readonly error: string }
  /** The station will not serve this watcher: not its session. */
  | { readonly kind: 'refused'; readonly why: string }

/**
 * What to do with work that must not happen more oftener than it should.
 *
 * A plain function is the whole of it. A schedule that can also be hurried
 * carries `now`: whoever knows a value is the last one — a finished run, a
 * closing tab — calls it and the wait is over. Schedules without it are simply
 * never in a hurry, and callers check before asking.
 */
export interface Hurried {
  (work: () => void): void
  /** Do what is owed at once, and start the next interval from here. */
  now(): void
}

export type Schedule = ((work: () => void) => void) | Hurried

/** Can this schedule be hurried? */
export const hurried = (schedule: Schedule): schedule is Hurried =>
  typeof (schedule as Hurried).now === 'function'

/**
 * Once a frame in the foreground — and still soon in the background, where the
 * browser freezes frames entirely: a leading tab must keep serving the others
 * after the person switches away, so a timer races the frame and whichever
 * comes first does the work, once.
 */
export const perFrame: Schedule = work => {
  const frame = (globalThis as { requestAnimationFrame?: (fn: () => void) => unknown })
    .requestAnimationFrame
  if (frame === undefined) {
    setTimeout(work, 0)
    return
  }
  let done = false
  const once = (): void => {
    if (done) return
    done = true
    work()
  }
  frame(once)
  setTimeout(once, 60)
}

/** Everything at once, for tests that want no waiting. */
export const atOnce: Schedule = work => work()

/**
 * No oftener than once every `ms`, and the last value always arrives.
 *
 * The word is the language's own: a gateway declares time as
 * `takes tick from time { every 1s }`, and a source declares its pace the same
 * way. Three names for one idea would be three vocabularies, so this is
 * `every` too — in a different place, with the same meaning.
 *
 * What it promises, and nothing besides: at most one flush per interval, and
 * the state after the last write is delivered. There is no leading or trailing
 * option here, deliberately — the channel already keeps the latest value per
 * cell, so what a flush carries is what is true now.
 *
 * Background tabs keep the same guard as `perFrame`: a timer, not a frame, so
 * a leading tab goes on serving the others after the person switches away.
 */
export function every(ms: number, timers: Timers = wallClock): Hurried {
  let waiting: (() => void) | null = null
  let timer: unknown = null

  const start = (): void => {
    timer = timers.set(function done() {
      timer = null
      const owed = waiting
      waiting = null
      if (owed === null) return
      // Something happened while we waited: do it, and start another interval,
      // so a storm of writes settles into one flush per interval rather than
      // two in a row at the boundary.
      owed()
      start()
    }, ms)
  }

  const schedule = ((work: () => void) => {
    // Inside an interval: remember the newest work and let the timer do it.
    if (timer !== null) {
      waiting = work
      return
    }
    work()
    start()
  }) as Hurried

  schedule.now = () => {
    const owed = waiting
    waiting = null
    if (timer !== null) {
      timers.clear(timer)
      timer = null
    }
    if (owed === null) {
      // Nothing was owed, so nothing was sent, so there is nothing to wait
      // after: an idle pace hurried is not an event, and the next write goes
      // at once as it would have anyway.
      return
    }
    owed()
    // The next interval starts from here, not from whenever the old one would
    // have ended: what was just sent is the new beginning.
    start()
  }

  return schedule
}
