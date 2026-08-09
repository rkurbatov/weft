// What a station offers, what a watcher gets, and what passes between them —
// said once.
//
// The station writes these and the mirror reads them, and neither is where a
// reader would look for the shape of the exchange: three files implement
// halves of one conversation. So the conversation is here, and each half is
// written against it.
//
// Not in `#wire` — where the message vocabulary used to live, beside the
// channel. A channel carries these and never reads one: it is a pipe, and a
// pipe knows nothing of what a station says down it. Keeping the vocabulary
// there made the pipe look like it understood the language.

import type { Watchable } from '#graph'
import type { Remote } from '#remote'
import type { Schedule } from '#wire'
import type { Timers } from '#core'

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
      /**
       * The keys in the order they are to be shown, when order is part of the
       * answer — a window onto an ordered view is the case.
       *
       * Keys, not rows: the order of twenty rows is twenty numbers, while the
       * rows themselves are only sent when they change. Without it a receiver
       * holds the right rows in the order they happened to arrive, which for a
       * scrolled window is no order at all.
       */
      readonly order?: readonly unknown[]
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

/**
 * A list published as a difference: its rows, and how a row is identified.
 *
 * Built with `listed()` rather than written out, so a station keeps its own
 * row type and the wire keeps none: a map of lists of different row types has
 * no honest element type, and asking for one would make every station cast.
 */
export interface ListOffer {
  readonly rows: Watchable<readonly unknown[]>
  readonly key: (row: unknown) => unknown
}

export interface Surface {
  /** Cells anyone may watch, by name. */
  cells?: Readonly<Record<string, Watchable<unknown>>>
  /** Cells that need a key: a family, by name. */
  families?: Readonly<Record<string, (key: never) => Watchable<unknown>>>
  /** What the other side may ask for. Arguments and answers must be cloneable. */
  commands?: Readonly<Record<string, (...args: never[]) => unknown>>
  /** Facts the other side may write into. Writing outside these is refused. */
  facts?: Readonly<Record<string, { set(value: never): void }>>
  /**
   * Tables the other side may follow.
   *
   * Named apart from `cells` on purpose: a table is not delivered like a value.
   * A watcher gets one snapshot and then batches of what changed, so a hundred
   * thousand rows do not cross the wire because one of them was edited. Hiding
   * that behind the same word would be lying to whoever reads the declaration.
   *
   * Asked for as the least a table must be, not as `Table<never>`: a table of
   * rows is not a table of nevers, and asking for one made every station cast
   * its own tables. The same mistake was made once with facts.
   */
  tables?: Readonly<Record<string, { readonly name: string }>>
  /**
   * Lists of rows that travel as differences rather than whole.
   *
   * A window onto a big table is the case: scrolling by one row used to send
   * the whole screen, because a list is one value and a value is sent whole.
   * Declared here with the key of a row, the station sends what entered and
   * what left — one row for one row of scrolling.
   *
   * The rows themselves stay wherever they are; this is only about what
   * crosses.
   */
  lists?: Readonly<Record<string, ListOffer>>
}

export interface ServeOptions {
  /** When to flush what has changed. Once a frame by default. */
  schedule?: Schedule
  /**
   * How many rows a list follower is remembered to have, per follower. Rows
   * inside the bound are put back by order alone when a window returns to
   * them; rows evicted past it are simply sent again. Tests shrink it to
   * reach the eviction path without walking thousands of rows.
   */
  remember?: number
  /** Told when a value cannot be sent — usually because it is not cloneable. */
  onUnsendable?: (cell: string, error: unknown) => void
  /**
   * Told when the channel itself is gone: nothing at all could be sent. What
   * had piled up stays where it is, and this side stops trying — a watcher
   * that comes back asks for everything anew. Without this the other side sits
   * with a stale picture it has no way of knowing is stale, which is worse
   * than an error.
   */
  onBroken?: (error: unknown) => void
}

export interface Link {
  /** Ask again for everything being watched. Called for you when the other side announces itself. */
  rewatch(): void
  /** A cell of the other side, by name; a family needs its key as well. */
  derived<T>(name: string, key?: unknown): Watchable<Remote<T>>
  /** A command of the other side. Arguments and the answer must be cloneable. */
  command<A extends readonly unknown[], T>(name: string): (...args: A) => Promise<T>
  /** Write into a fact the other side published. */
  write(fact: string, value: unknown): void
  /**
   * A table of the other side, kept up to date by batches of changes.
   *
   * The rows arrive once and then only what changed arrives, so editing one
   * row of a hundred thousand costs one row on the wire. While a lost batch is
   * being made up for, the rows already here stay on screen — `catchingUp`
   * says that is what is happening, and stale-but-labelled beats blank.
   */
  table<R>(name: string): Mirrored<R>
  /** How many mirrors are held right now. */
  held(): number
  close(): void
}

/** A table on this side of a wire: rows, and whether they are behind. */
export interface Mirrored<R> {
  readonly rows: Watchable<readonly R[]>
  /** Nothing has arrived yet — no snapshot, no rows. */
  readonly cold: Watchable<boolean>
  /** A batch was lost and the rows on screen are the last good ones. */
  readonly catchingUp: Watchable<boolean>
  /**
   * How many rows have actually arrived over the wire: the snapshot, plus
   * every row of every batch since.
   *
   * Counted here because here is where they land. Counted on the other side it
   * would be the rows the list handed out, which is not the same number and
   * not the interesting one — a demo said "rows that crossed the wire" while
   * counting something else entirely.
   */
  readonly received: Watchable<number>
  /**
   * How many times this side had to be caught up: a batch was lost, and the
   * station answered with everything rather than with changes that would not
   * fit.
   *
   * Worth showing beside `received`, or the count of rows looks inexplicably
   * high: one catch-up costs a whole table.
   */
  readonly caughtUp: Watchable<number>
}

export interface LinkOptions {
  /**
   * Every ask over the wire waits at most this long; past it the call rejects
   * with Unknown — the graph may have done the work, nobody knows. Waiting is
   * finite by design: an ask with no term would hang for as long as the wire
   * stays politely silent.
   */
  within?: number
  /** An idle mirror lingers this long before it is let go of; a fresh look
   *  re-creates it. Keeps a family of mirrors from growing immortal. */
  linger?: number
  timers?: Timers
  /**
   * How long to wait before asking again for a catch-up that went unanswered.
   * Doubles per attempt, capped at `askAgainCap`.
   *
   * The ask can be lost like anything else on a wire, and the flag that keeps
   * one incident from becoming a storm would then never come down. Between
   * workers this is theory; over a network it is a Tuesday.
   */
  askAgain?: number
  askAgainCap?: number
  /**
   * The station refused to serve this side — it holds somebody else's
   * household. Nothing will ever arrive; the screen should say so rather than
   * spin. Without a handler the refusal is thrown, since silence here looks
   * exactly like a slow wire.
   */
  onRefused?: (why: string) => void
}
