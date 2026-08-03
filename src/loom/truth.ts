// The door of truth. One word for source and query: a question with
// parameters is the same truth, keyed. The law of the adjective: asynchrony
// is not a wrapper — truth reads as a plain value of a declared empty shape,
// and flight, fault and freshness are cells standing beside it. heldOf does
// not exist in application code.

import { cell } from '#weft'
import type { Watchable } from '#weft'
import { heldOf } from '#weft'
import type { Remote } from '#weft'
import { arrivalOf, source } from '#weft'
import { query } from '#weft'
import type { Timers } from '#weft'

export interface TruthPassport<T> {
  /** What the value reads as before anything arrived. */
  empty: T
  /** Ask again this often while watched. */
  poll?: number
  /** The quiet a look must survive before it becomes a question. */
  calm?: number
  /** How long an answer stays fresh. */
  shelfLife?: number
  /** For keyed truth: how many answers the family keeps. */
  keep?: number
  name?: string
  timers?: Timers
  now?: () => number
}

export interface Truth<T> {
  get(): T
  peek(): T
  /** For a tree that suspends: only a cold start suspends — anything held,
   *  however stale, is returned; a cold refusal is thrown to the boundary. */
  suspend(): T
  /** An ask is under way. */
  flight: Watchable<boolean>
  /** The last refusal, or null. A fault does not take away what is held. */
  fault: Watchable<string | null>
  /** When the standing answer's question was asked; 0 before anything came. */
  asked: Watchable<number>
  refresh(): Promise<void>
}

interface Carried<T> {
  value: T
  askedAt: number
}

function faceOf<T>(
  feed: { state: Watchable<Remote<Carried<T>>> },
  empty: T,
  refresh: () => Promise<void>,
  name: string,
): Truth<T> {
  const state = feed.state
  const value = cell(() => heldOf(state.get())?.value.value ?? empty, { name: `${name}.value` })
  const flight = cell(() => state.get().loading, { name: `${name}.flight` })
  const fault = cell(
    () => {
      const s = state.get()
      return s.kind === 'failed' ? String(s.error) : null
    },
    { name: `${name}.fault` },
  )
  const asked = cell(() => heldOf(state.get())?.value.askedAt ?? 0, { name: `${name}.asked` })
  return {
    get: () => value.get(),
    peek: () => value.peek(),
    suspend: () => {
      const s = state.get() // the look itself is the demand
      const held = heldOf(s)
      if (held !== undefined) return held.value.value // stale shows while the fresh travels
      if (s.kind === 'failed') throw s.error // a cold refusal goes to the boundary
      throw arrivalOf(feed) // a cold start suspends on the landing
    },
    flight,
    fault,
    asked,
    refresh,
  }
}

export function truth<T>(ask: () => Promise<T>, passport: TruthPassport<T>): Truth<T> {
  const name = passport.name ?? 'truth'
  const feed = source<Carried<T>>(
    async () => {
      const askedAt = Date.now()
      return { value: await ask(), askedAt }
    },
    {
      name,
      ...(passport.poll === undefined ? {} : { every: passport.poll }),
      ...(passport.calm === undefined ? {} : { calm: passport.calm }),
      ...(passport.shelfLife === undefined ? {} : { shelfLife: passport.shelfLife }),
      ...(passport.timers === undefined ? {} : { timers: passport.timers }),
      ...(passport.now === undefined ? {} : { now: passport.now }),
    },
  )
  return faceOf(feed, passport.empty, () => feed.refresh(), name)
}

/** Keyed truth: the same door, a family behind it. */
export function truthBy<K, T>(
  ask: (key: K) => Promise<T>,
  passport: TruthPassport<T>,
): (key: K) => Truth<T> {
  const name = passport.name ?? 'truth'
  const family = query<K, Carried<T>>(
    async (key: K) => {
      const askedAt = Date.now()
      return { value: await ask(key), askedAt }
    },
    {
      name,
      max: passport.keep ?? 32,
      ...(passport.calm === undefined ? {} : { calm: passport.calm }),
      ...(passport.shelfLife === undefined ? {} : { shelfLife: passport.shelfLife }),
      ...(passport.timers === undefined ? {} : { timers: passport.timers }),
      ...(passport.now === undefined ? {} : { now: passport.now }),
    },
  )
  const faces = new Map<unknown, Truth<T>>()
  return (key: K): Truth<T> => {
    const at = JSON.stringify(key)
    const known = faces.get(at)
    if (known !== undefined) return known
    const feed = family(key)
    const face = faceOf(feed, passport.empty, () => feed.refresh(), `${name}:${at}`)
    faces.set(at, face)
    return face
  }
}
