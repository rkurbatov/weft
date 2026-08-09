// The door of volition. The single place the vocabulary of intents is
// declared: sends — what to say to the world, notes — kinds of faits
// accomplis. Calls are typed; strings do not exist at call sites. The law of
// the key: every note carries a client key from the moment it is written; a
// sender that creates state must hand the key to the world, and the world
// must recognize a repeat by it.

import type { Now } from '#core'
import { derived, port } from '#weft'
import type { Watchable } from '#weft'
import { bestStore } from '#weft'
import type { Store } from '#weft'
import { outbox } from '#weft'
import type { Handler, Note } from '#weft'

// The queue's own word is already the language's: a note. Passed through, not
// renamed — the dialect and the engine call it the same thing.
export type { Note }
import type { Fault } from '#weft'
import type { Timers } from '#core'

declare const OP: unique symbol

export interface Sends<T> {
  readonly kind: 'sends'
  readonly go: (op: T, key: string) => Promise<unknown>
  readonly [OP]?: T
}

export interface Notes<T> {
  readonly kind: 'notes'
  readonly [OP]?: T
}

/** What to say to the world for this kind of intent. */
export function sends<T>(go: (op: T, key: string) => Promise<unknown>): Sends<T> {
  return { kind: 'sends', go }
}

/** A kind of fait accompli: confirmed elsewhere, laid over until absorbed. */
export function notes<T>(): Notes<T> {
  return { kind: 'notes' }
}

// `any` on purpose: the dict's own literal types carry the truth; the
// constraint must accept every Sends<T> without fixing T.
// oxlint-disable-next-line no-explicit-any
export type WillDict = Readonly<Record<string, Sends<any> | Notes<any>>>

type OpOf<S> = S extends Sends<infer T> ? T : S extends Notes<infer T> ? T : never

export type Speak<D extends WillDict> = {
  readonly [K in keyof D]: D[K] extends Sends<infer T>
    ? (op: T, key?: string) => Promise<void>
    : D[K] extends Notes<infer T>
      ? (op: T) => void
      : never
}

export interface Refusal {
  kind: string
  op: unknown
  error: string
}

export interface WillPassport {
  name?: string
  /** Where the book lives. Default: the best shelf this platform has, since a
   *  book of unsent intents that dies with the tab is not a book. */
  store?: Store
  /** Sort a sender's failure. Default: everything is transient. */
  judge?: (error: unknown) => Fault
  retry?: number
  timers?: Timers
  now?: Now
}

export interface WillBase<D extends WillDict> {
  /** The whole book of notes, for pictures to lay over. */
  notes: Watchable<readonly Note[]>
  /** Keys of subjects with an intent still owed to the world. */
  pending(
    pick: (kind: keyof D & string, op: OpOf<D[keyof D]>) => string | undefined,
  ): Watchable<ReadonlySet<string>>
  owed: Watchable<number>
  /** The last permanent refusal, with its trace. Silence is not an option. */
  refused: Watchable<Refusal | null>
  /** Where this book lives: 'memory' means it dies with the tab, 'given' means
   *  the passport handed in a shelf and only the caller knows what it is. */
  shelf: 'disk' | 'memory' | 'given'
  /** Offline: pause() holds the book, resume() sends what is owed. */
  pause(): void
  resume(): void
  /** The base has caught up to this moment (used by laid). */
  absorb(before: number): void
}

export type Will<D extends WillDict> = WillBase<D> & Speak<D>

export function will<D extends WillDict>(dict: D, passport: WillPassport = {}): Will<D> {
  const name = passport.name ?? 'will'
  const shelf = bestStore(`weft.${name}`)
  const refused = port<Refusal | null>(null, { name: `${name}.refused` })

  const handlers: Record<string, Handler> = {}
  for (const [kind, spec] of Object.entries(dict)) {
    if (spec.kind !== 'sends') continue
    const go = spec.go as (op: unknown, key: string) => Promise<unknown>
    handlers[kind] = async (args, handling) => {
      await go(args, handling.key)
    }
  }

  const box = outbox({
    key: name,
    store: passport.store ?? shelf,
    handlers,
    retain: true,
    ...(passport.judge === undefined ? {} : { classify: passport.judge }),
    ...(passport.retry === undefined ? {} : { retry: passport.retry }),
    ...(passport.timers === undefined ? {} : { timers: passport.timers }),
    ...(passport.now === undefined ? {} : { now: passport.now }),
    onRefused: entry =>
      refused.set({ kind: entry.name, op: entry.args, error: entry.lastError ?? 'refused' }),
    onStuck: entry =>
      refused.set({ kind: entry.name, op: entry.args, error: entry.lastError ?? 'stuck' }),
  })

  const speak: Record<string, unknown> = {}
  for (const [kind, spec] of Object.entries(dict)) {
    speak[kind] =
      spec.kind === 'sends'
        ? (op: unknown, key?: string) =>
            box.send(kind, op, key === undefined ? undefined : { key }).done.catch(() => {})
        : (op: unknown) => {
            box.note(kind, op)
          }
  }

  const base: WillBase<D> = {
    notes: box.entries,
    pending: pick =>
      derived(
        () => {
          const ids = new Set<string>()
          for (const entry of box.entries.get()) {
            if (entry.state === 'done' || entry.state === 'stuck') continue
            const id = pick(entry.name as keyof D & string, entry.args as OpOf<D[keyof D]>)
            if (id !== undefined) ids.add(id)
          }
          return ids
        },
        { name: `${name}.pending` },
      ),
    owed: box.owed,
    refused,
    shelf: passport.store === undefined ? shelf.where : 'given',
    pause: () => box.pause(),
    resume: () => box.resume(),
    absorb: before => box.absorb(before),
  }

  return Object.assign(base, speak) as Will<D>
}
