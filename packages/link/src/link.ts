// The watching side. A mirrored cell is an ordinary stored cell whose single
// writer is the wire, and watching it is what asks the other side for it:
// demand crosses the boundary by itself, so nothing has to be released by hand.

import { port, untracked } from '#graph/graph.ts'
import type { Port, Watchable } from '#graph/graph.ts'
import { EMPTY, arrived, heldOf, refused } from '#remote/remote.ts'
import { preserve } from '#data/preserve.ts'
import type { Remote } from '#remote/remote.ts'
import { wallClock } from '#graph/time.ts'
import type { Timers } from '#graph/time.ts'
import type { Channel, ToWatcher } from './channel.ts'
import { notice } from '#data'

/**
 * The third outcome of an ask, told apart from a refusal: no answer came and
 * none will, but the other side may have done the work. After a refusal a
 * retry is safe; after Unknown — only with an idempotency key.
 */
export class Unknown extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Unknown'
  }
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

/** The three cells a followed table hands out. */
const faceOfTable = (made: {
  rows: Port<readonly unknown[]>
  cold: Port<boolean>
  catchingUp: Port<boolean>
}): Mirrored<unknown> => ({ rows: made.rows, cold: made.cold, catchingUp: made.catchingUp })

/** A table on this side of a wire: rows, and whether they are behind. */
export interface Mirrored<R> {
  readonly rows: Watchable<readonly R[]>
  /** Nothing has arrived yet — no snapshot, no rows. */
  readonly cold: Watchable<boolean>
  /** A batch was lost and the rows on screen are the last good ones. */
  readonly catchingUp: Watchable<boolean>
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
   * The station refused to serve this side — it holds somebody else's
   * household. Nothing will ever arrive; the screen should say so rather than
   * spin. Without a handler the refusal is thrown, since silence here looks
   * exactly like a slow wire.
   */
  onRefused?: (why: string) => void
}

export function link(channel: Channel, options: LinkOptions = {}): Link {
  const within = options.within ?? 10_000
  const linger = options.linger ?? 15_000
  const timers = options.timers ?? wallClock
  const mirrors = new Map<string, { id: number; cell: Port<Remote<unknown>> }>()
  /** Which table each follow is for, so an arriving batch finds its rows. */
  const byTable = new Map<number, string>()
  const lingering = new Set<unknown>()
  const byId = new Map<number, Port<Remote<unknown>>>()
  /** Which name each watch was made for, so a refusal can be named out loud. */
  const nameOf = new Map<number, string>()
  const waiting = new Map<
    number,
    { resolve: (value: never) => void; reject: (error: unknown) => void; held?: unknown }
  >()

  const settleCall = (
    id: number,
  ): { resolve: (value: never) => void; reject: (error: unknown) => void } | undefined => {
    const waiter = waiting.get(id)
    if (waiter === undefined) return undefined
    waiting.delete(id)
    if (waiter.held !== undefined) timers.clear(waiter.held)
    return waiter
  }

  const rejectAll = (make: () => Error): void => {
    for (const waiter of waiting.values()) {
      if (waiter.held !== undefined) timers.clear(waiter.held)
      waiter.reject(make())
    }
    waiting.clear()
  }
  let next = 1

  const stopListening = channel.listen(raw => {
    const message = raw as ToWatcher
    switch (message?.kind) {
      case 'up': {
        // A fresh graph knows nothing of calls sent to the old one. Their
        // answers died with it — which is not the same as a refusal.
        rejectAll(() => new Unknown('weft: the graph restarted before answering'))
        rewatch()
        return
      }
      case 'values':
        for (const { id, value } of message.changed) {
          const mirror = byId.get(id)
          if (mirror === undefined) continue
          // The identity of unchanged pieces survives the crossing: the same
          // piece stays the very same object, so gating works past the wire.
          const was = heldOf(mirror.peek())?.value
          mirror.set(arrived(was === undefined ? value : preserve(was, value), Date.now()))
        }
        return
      case 'done': {
        settleCall(message.id)?.resolve(message.value as never)
        return
      }
      case 'refused': {
        const told = options.onRefused
        if (told === undefined) throw new Error(`weft: station refused this side — ${message.why}`)
        told(message.why)
        return
      }
      case 'rows': {
        const name = byTable.get(message.id)
        const made = name === undefined ? undefined : tables.get(name)
        if (made === undefined) return
        made.held.clear()
        for (const { key, row } of message.rows) made.held.set(key, row)
        made.at = message.at
        made.rows.set([...made.held.values()])
        made.cold.set(false)
        made.catchingUp.set(false)
        return
      }
      case 'changed': {
        const name = byTable.get(message.id)
        const made = name === undefined ? undefined : tables.get(name)
        if (made === undefined) return
        if (made.at !== message.from) {
          // A batch was lost: these changes were computed against a state this
          // side is not in, and applying them would quietly corrupt the rows.
          // What is on screen stays there, labelled, until the catch-up lands.
          made.catchingUp.set(true)
          channel.send({ kind: 'catchUp', id: message.id, since: made.at })
          return
        }
        for (const change of message.changes) {
          if (change.next === null) made.held.delete(change.key)
          else made.held.set(change.key, change.next)
        }
        made.at = message.to
        made.rows.set([...made.held.values()])
        made.catchingUp.set(false)
        return
      }
      case 'failed': {
        const waiter = settleCall(message.id)
        if (waiter !== undefined) {
          waiter.reject(new Error(message.error))
          return
        }
        // Not a call, then: a cell the other side does not have — a refusal,
        // told apart from "nothing arrived yet".
        const mirror = byId.get(message.id)
        mirror?.set(refused(mirror.peek(), new Error(message.error), 1, 'rejected'))
        // And said out loud. A screen reading a mirror plainly sees `undefined`
        // either way, so a name the station never published looks exactly like
        // an answer that has not landed yet — for as long as the tab is open.
        // A typo lived a whole afternoon behind that silence.
        notice({
          kind: 'mirror-refused',
          where: nameOf.get(message.id) ?? String(message.id),
          level: 'warn',
          message:
            `the station refused a mirror of "${nameOf.get(message.id) ?? '?'}": ${message.error}. ` +
            `A view is offered under \`views\`; a name offered only under \`facts\` can be ` +
            `written but not watched.`,
          detail: { error: message.error },
        })
        return
      }
      default:
        return
    }
  })

  /** Ask again for everything somebody is still watching. */
  function rewatch(): void {
    for (const [at, mirror] of mirrors) {
      if (!mirror.cell.demanded) continue
      const [name, rawKey] = at.split('\u0000')
      channel.send({
        kind: 'watch',
        id: mirror.id,
        cell: name,
        key: rawKey === undefined ? undefined : (JSON.parse(rawKey) as unknown),
      })
    }
  }

  function mirrorOf(name: string, key: unknown): Port<Remote<unknown>> {
    const at = key === undefined ? name : `${name}\u0000${JSON.stringify(key)}`
    const known = mirrors.get(at)
    if (known !== undefined) return known.cell

    const id = next++
    let letGo: unknown
    const cell = port<Remote<unknown>>(EMPTY, {
      name: at,
      // Watching here is asking there; nobody watching is nobody asking.
      onDemand: () => {
        timers.clear(letGo as never)
        lingering.delete(letGo)
        // A look may return after the mirror was let go of: register again.
        mirrors.set(at, { id, cell })
        byId.set(id, cell)
        nameOf.set(id, name)
        channel.send({ kind: 'watch', id, cell: name, key })
      },
      onIdle: () => {
        channel.send({ kind: 'unwatch', id })
        untracked(() => cell.set(EMPTY))
        // Not dropped at once — a linger, then let go. The handle out there
        // stays valid: its next look re-registers the very same mirror.
        letGo = timers.set(() => {
          lingering.delete(letGo)
          mirrors.delete(at)
          byId.delete(id)
        }, linger)
        lingering.add(letGo)
        // Housekeeping must not keep a process alive where the platform can say so.
        ;(letGo as { unref?: () => void }).unref?.()
      },
    })
    mirrors.set(at, { id, cell })
    byId.set(id, cell)
    return cell
  }

  /**
   * Tables followed over this wire, by name.
   *
   * Rows are kept in a map by key and handed out as an array — the array is
   * rebuilt when something changes and kept otherwise, so a screen that redraws
   * on identity is not woken by a batch that changed nothing it shows.
   */
  const tables = new Map<
    string,
    {
      id: number
      rows: Port<readonly unknown[]>
      cold: Port<boolean>
      catchingUp: Port<boolean>
      held: Map<unknown, unknown>
      at: number
    }
  >()

  function tableOf<R>(name: string): Mirrored<R> {
    const known = tables.get(name)
    if (known !== undefined) return faceOfTable(known) as Mirrored<R>

    const id = next++
    const made = {
      id,
      rows: port<readonly unknown[]>([], {
        name: `${name}.rows`,
        // Following starts when somebody looks and stops when nobody does —
        // the same rule cells live by, so a table nobody shows costs nothing.
        onDemand: () => channel.send({ kind: 'follow', id, table: name }),
        onIdle: () => {
          channel.send({ kind: 'unfollow', id })
          untracked(() => {
            made.held.clear()
            made.rows.set([])
            made.cold.set(true)
            made.at = 0
          })
        },
      }),
      cold: port(true, { name: `${name}.cold` }),
      catchingUp: port(false, { name: `${name}.catchingUp` }),
      held: new Map<unknown, unknown>(),
      at: 0,
    }
    tables.set(name, made)
    byTable.set(id, name)
    return faceOfTable(made) as Mirrored<R>
  }

  return {
    rewatch,
    table: <R>(name: string) => tableOf<R>(name),
    /** How many mirrors are held right now. For the instruments' eyes. */
    held: () => mirrors.size,
    derived: <T>(name: string, key?: unknown) =>
      mirrorOf(name, key) as unknown as Watchable<Remote<T>>,

    command<A extends readonly unknown[], T>(name: string) {
      return (...args: A): Promise<T> => {
        const id = next++
        const answer = new Promise<T>((resolve, reject) => {
          // Waiting is finite by design: past the term the outcome is unknown,
          // and a late answer is not owed to anyone.
          const held = timers.set(() => {
            settleCall(id)?.reject(new Unknown(`weft: "${name}" gave no answer within ${within}ms`))
          }, within)
          waiting.set(id, { resolve: resolve as (value: never) => void, reject, held })
        })
        // An ignored answer must not look like a lost error.
        answer.catch(() => {})
        channel.send({ kind: 'call', id, command: name, args })
        return answer
      }
    },

    write(fact, value) {
      channel.send({ kind: 'write', fact, value })
    },

    close() {
      // Let the graph go: watches we leave behind would hold demand there
      // forever. A dead wire may refuse the send — closing must not fail on it.
      try {
        for (const { id, cell } of mirrors.values()) {
          if (cell.demanded) channel.send({ kind: 'unwatch', id })
        }
      } catch {
        // The other side is gone, then; there is nothing to release.
      }
      stopListening()
      rejectAll(() => new Unknown('weft: the link closed before an answer came'))
      for (const held of lingering) timers.clear(held as never)
      lingering.clear()
      mirrors.clear()
      byId.clear()
      channel.close?.()
    },
  }
}
