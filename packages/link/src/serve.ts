// The graph's side of the wire. It publishes named cells and named commands and
// answers whoever asks. Watching from the other side is ordinary demand: the
// first watcher wakes whatever the cell depends on, the last one lets it go.

import { subscribe, untracked, watch } from '#graph'
import type { Watchable } from '#graph'
import { perFrame } from '#wire'
import type { Channel, Schedule, ToGraph } from '#wire'
import { handedOver } from './handover.ts'
import { feedOf } from '#table'
import { follow } from '#feed'
import type { Table } from '#table'

/** A list published as a difference: its rows, and how a row is identified. */
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

/** Publish a list of rows, identified by key. */
export function listed<R>(rows: Watchable<readonly R[]>, key: (row: R) => unknown): ListOffer {
  return {
    rows: rows as Watchable<readonly unknown[]>,
    key: row => key(row as R),
  }
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

/**
 * A value declared as handed over travels as its own contents.
 *
 * The wrapper is the application's way of saying "this one is one-off"; what
 * crosses is the value itself, so the far side reads it as it would any other.
 */
const unwrap = (value: unknown): unknown => (handedOver(value) ? value.value : value)

/** Buffers to hand over with this batch, if any were declared. */
function buffersIn(batch: readonly { value: unknown }[]): readonly ArrayBufferLike[] {
  const found: ArrayBufferLike[] = []
  for (const one of batch) {
    if (!handedOver(one.value)) continue
    for (const buffer of one.value.buffers) found.push(buffer)
  }
  return found
}

export function serve(surface: Surface, channel: Channel, options: ServeOptions = {}): () => void {
  const schedule = options.schedule ?? perFrame
  const watching = new Map<number, () => void>()
  // The latest value per watch, not a queue of them: a slow reader gets what is
  // true now, not a history of what was.
  const pending = new Map<number, unknown>()
  // Which cell each watch is on, so a complaint can name it.
  const named = new Map<number, string>()
  let flushing = false
  let broken = false

  function flush(): void {
    flushing = false
    if (pending.size === 0 || broken) return
    const wrapped = [...pending].map(([id, value]) => ({ id, value }))
    // Buffers are taken from the values as they came, before the wrapper is
    // stripped: unwrapping first left the list empty, and the send quietly
    // copied instead of handing over.
    const handing = buffersIn(wrapped)
    const changed = wrapped.map(one => ({ id: one.id, value: unwrap(one.value) }))
    try {
      channel.send({ kind: 'values', changed }, handing)
      // Cleared only now, and only what was actually sent: a value written
      // again while this was in flight stays pending on its own account.
      for (const one of changed) settled(one)
      return
    } catch (error) {
      // Either one value will not clone, or the channel is gone. Sending them
      // one at a time tells the two apart.
      let sent = 0
      for (const one of changed) if (sendAlone(one)) sent++
      // Nothing got through. That is either a batch where every value refuses
      // to clone, or a channel that is gone — and the two want opposite
      // answers. An empty message tells them apart: it clones trivially, so
      // only a dead channel refuses it.
      if (sent === 0 && changed.length > 0 && !alive()) fell(error)
    }
  }

  /** Sent: drop it, unless it has been written again in the meantime. */
  function settled(one: { id: number; value: unknown }): void {
    if (pending.get(one.id) === one.value) pending.delete(one.id)
  }

  function sendAlone(one: { id: number; value: unknown }): boolean {
    try {
      channel.send(
        { kind: 'values', changed: [{ id: one.id, value: unwrap(one.value) }] },
        buffersIn([one]),
      )
      settled(one)
      return true
    } catch (error) {
      complain(one.id, error)
      // A value nobody can clone would block the queue forever; it is named
      // and dropped, and only it.
      settled(one)
      return false
    }
  }

  /** Is there still a channel at all? Asked only after everything failed. */
  function alive(): boolean {
    try {
      channel.send({ kind: 'values', changed: [] })
      return true
    } catch {
      return false
    }
  }

  /** The channel is gone. Keep what piled up, stop trying, say so once. */
  function fell(error: unknown): void {
    if (broken) return
    broken = true
    options.onBroken?.(error)
  }

  function complain(id: number, error: unknown): void {
    options.onUnsendable?.(named.get(id) ?? String(id), error)
  }

  function later(): void {
    if (flushing) return
    flushing = true
    schedule(flush)
  }

  function cellOf(name: string, key: unknown): Watchable<unknown> | undefined {
    const plain = surface.cells?.[name]
    if (plain !== undefined) return plain
    const keyed = surface.families?.[name]
    return keyed === undefined ? undefined : keyed(key as never)
  }

  /**
   * Following a table: a snapshot, then batches of what changed.
   *
   * The change log and the catching up already exist in the table; what is new
   * here is carrying them across. Nothing is invented — the batch a follower
   * gets is the batch the table recorded, and the version numbers are the
   * table's own, so both sides can tell a lost batch from a quiet one.
   */
  const following = new Map<number, () => void>()

  function onFollow(message: Extract<ToGraph, { kind: 'follow' }>): void {
    if (following.has(message.id)) return
    const list = surface.lists?.[message.table]
    if (list !== undefined) {
      followList(
        message.id,
        list as { rows: Watchable<readonly unknown[]>; key: (row: unknown) => unknown },
      )
      return
    }
    const table = surface.tables?.[message.table]
    if (table === undefined) {
      channel.send({ kind: 'failed', id: message.id, error: `no table "${message.table}"` })
      return
    }
    // The one cast, made here rather than by every application: a station
    // declares its tables, and what a table is made of is its own business.
    const feed = feedOf(table as Table<unknown>)
    if (feed === undefined) {
      channel.send({ kind: 'failed', id: message.id, error: `"${message.table}" is not a table` })
      return
    }

    const sendRows = (): void => {
      const rows: { key: unknown; row: unknown }[] = []
      feed.each(row => rows.push({ key: feed.keyOf(row), row }))
      channel.send({ kind: 'rows', id: message.id, at: untracked(() => feed.version.get()), rows })
    }

    let sent = 0
    // `follow` returns a function that brings this follower up to date; it has
    // to be called inside something that watches the feed's version, which is
    // what the watcher below does.
    const catchUpNow = follow(feed, {
      first: () => {
        sent = untracked(() => feed.version.get())
        sendRows()
      },
      apply: changes => {
        const to = untracked(() => feed.version.get())
        channel.send({
          kind: 'changed',
          id: message.id,
          from: sent,
          to,
          changes: changes.map(change => ({ key: change.key, next: change.next ?? null })),
        })
        sent = to
      },
      // The table has forgotten how to get from there to here, so it says so
      // with everything rather than with a silence.
      resync: () => {
        sent = untracked(() => feed.version.get())
        sendRows()
      },
    })
    const stop = watch(catchUpNow)
    following.set(message.id, stop)
  }

  /**
   * Following a list: the rows once, then what entered and what left.
   *
   * The difference is taken here, against what this follower was last sent —
   * not against what the list held a moment ago — so a follower that missed
   * nothing gets exactly the rows that changed for it.
   */
  function followList(id: number, list: ListOffer, keep = options?.remember ?? 4096): void {
    let sentKeys = new Map<unknown, unknown>()
    let at = 0
    /**
     * Rows this follower already has, including ones no longer in the list.
     *
     * A window scrolled down and back up asks for rows it was sent a moment
     * ago; without this they are sent again, and elbowing about one place on
     * screen keeps paying for the same rows. Bounded, because a follower that
     * has walked a hundred thousand rows should not be remembered whole.
     */
    const alreadySent = new Map<unknown, unknown>()

    const send = (rows: readonly unknown[], first: boolean): void => {
      const now = new Map<unknown, unknown>()
      for (const row of rows) now.set(list.key(row), row)

      if (first) {
        at = 1
        sentKeys = now
        for (const [key, row] of now) alreadySent.set(key, row)
        channel.send({ kind: 'rows', id, at, rows: [...now].map(([key, row]) => ({ key, row })) })
        return
      }

      const order = [...now.keys()]

      const changes: { key: unknown; next: unknown | null }[] = []
      for (const [key, row] of now) {
        // Sent before and unchanged since: the other side still has it, so the
        // order alone puts it back on screen.
        if (alreadySent.get(key) === row) continue
        changes.push({ key, next: row })
        alreadySent.set(key, row)
      }
      // Nothing is dropped here: what left the window is kept on the far side
      // and put back by the order when it returns. The bound below is what
      // stops that from growing without end.
      //
      // A key on screen right now is never the one to go. Insertion order is
      // the age here, and a `set` on a key the map already holds does not
      // move it — so a row sent early and sitting quietly in the window can
      // be the oldest entry at the very moment the cache overflows. Evicting
      // it sends `next: null`, and the far side deletes a row the person is
      // looking at. Such a key is re-inserted instead, which both spares it
      // and moves it to the young end, and the loop walks on.
      let spared = 0
      while (alreadySent.size - spared > keep) {
        const oldest = alreadySent.keys().next().value
        if (oldest === undefined) break
        if (now.has(oldest)) {
          const row = alreadySent.get(oldest)
          alreadySent.delete(oldest)
          alreadySent.set(oldest, row)
          spared++
          continue
        }
        alreadySent.delete(oldest)
        changes.push({ key: oldest, next: null })
      }
      const sameOrder =
        order.length === sentKeys.size && order.every((key, i) => [...sentKeys.keys()][i] === key)
      if (changes.length === 0 && sameOrder) return

      const from = at
      at++
      sentKeys = now
      channel.send({ kind: 'changed', id, from, to: at, changes, order })
    }

    // The snapshot goes now, not on the first change: a subscription reports
    // changes, and waiting for one meant a follower saw nothing at all until
    // the list happened to move.
    send(
      untracked(() => list.rows.get()),
      true,
    )
    const stop = subscribe(list.rows, rows => send(rows, false))
    following.set(id, stop)
  }

  function onCatchUp(message: Extract<ToGraph, { kind: 'catchUp' }>): void {
    const stop = following.get(message.id)
    if (stop === undefined) return
    // Whoever asks has fallen behind; the simplest honest answer is the state
    // as it is now. Sending the missing batches instead is an optimisation for
    // the day a snapshot turns out to be too big to send.
    stop()
    following.delete(message.id)
    onFollow({ kind: 'follow', id: message.id, table: nameOfFollow.get(message.id) ?? '' })
  }

  /** Which table each follow was for, so a catch-up can be answered. */
  const nameOfFollow = new Map<number, string>()

  function onWatch(message: Extract<ToGraph, { kind: 'watch' }>): void {
    if (watching.has(message.id)) return
    const cell = cellOf(message.cell, message.key)
    if (cell === undefined) {
      channel.send({ kind: 'failed', id: message.id, error: `no cell "${message.cell}"` })
      return
    }
    const stop = subscribe(cell, value => {
      pending.set(message.id, value)
      later()
    })
    watching.set(message.id, stop)
    named.set(message.id, message.cell)
    // The first value goes at once: a screen should not wait a frame to show.
    pending.set(
      message.id,
      untracked(() => cell.get()),
    )
    later()
  }

  async function onCall(message: Extract<ToGraph, { kind: 'call' }>): Promise<void> {
    const command = surface.commands?.[message.command]
    if (command === undefined) {
      channel.send({ kind: 'failed', id: message.id, error: `no command "${message.command}"` })
      return
    }
    try {
      const value = await (command as (...args: unknown[]) => unknown)(...message.args)
      channel.send({ kind: 'done', id: message.id, value })
    } catch (error) {
      channel.send({
        kind: 'failed',
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const stopListening = channel.listen(raw => {
    const message = raw as ToGraph
    switch (message?.kind) {
      case 'watch':
        onWatch(message)
        return
      case 'unwatch': {
        watching.get(message.id)?.()
        watching.delete(message.id)
        pending.delete(message.id)
        named.delete(message.id)
        return
      }
      case 'call':
        void onCall(message)
        return
      case 'write': {
        surface.facts?.[message.fact]?.set(message.value as never)
        return
      }
      case 'follow': {
        nameOfFollow.set(message.id, message.table)
        onFollow(message)
        return
      }
      case 'unfollow': {
        following.get(message.id)?.()
        following.delete(message.id)
        nameOfFollow.delete(message.id)
        return
      }
      case 'catchUp': {
        onCatchUp(message)
        return
      }
      default:
        return
    }
  })

  // Say we are here: a watcher that outlived the last graph must ask again.
  channel.send({ kind: 'up' })

  return () => {
    for (const stop of following.values()) stop()
    following.clear()
    nameOfFollow.clear()
    stopListening()
    for (const stop of watching.values()) stop()
    watching.clear()
    pending.clear()
    named.clear()
  }
}
