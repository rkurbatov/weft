// The door of truth. One word for supply and query: a question with
// parameters is the same truth, keyed. The law of the adjective: asynchrony
// is not a wrapper — truth reads as a plain value of a declared empty shape,
// and flight, fault and freshness are cells standing beside it. heldOf does
// not exist in application code.

import type { Now } from '#core'
import { derived } from '#weft'
import type { Tally, Watchable } from '#weft'
import { heldOf } from '#weft'
import type { Remote } from '#weft'
import { arrivalOf, supply } from '#weft'
import { query } from '#weft'
import type { Timers } from '#core'

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
  now?: Now
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
  /**
   * What this truth has done: asked, answered, called off, refused, published.
   *
   * Ordinary cells. Here because the engine knows these numbers exactly — it
   * raises the abort itself — and an application that counts them by hand gets
   * them wrong: a run called off between two steps never gets a turn to notice,
   * and a finished run whose question was dropped is not called off at all.
   */
  tally: Tally
  refresh(): Promise<void>
}

interface Carried<T> {
  value: T
  askedAt: number
  /**
   * Whether this is the whole answer or a piece of one on the way. A piece is
   * a real value and shows like one, but it is not a snapshot of the world:
   * nothing may conclude from it that a write it was waiting to see is in
   * there.
   */
  whole: boolean
}

function faceOf<T>(
  feed: { state: Watchable<Remote<Carried<T>>>; tally: Tally },
  empty: T,
  refresh: () => Promise<void>,
  name: string,
): Truth<T> {
  const state = feed.state
  const value = derived(() => heldOf(state.get())?.value.value ?? empty, { name: `${name}.value` })
  const flight = derived(() => state.get().loading, { name: `${name}.flight` })
  const fault = derived(
    () => {
      const s = state.get()
      return s.kind === 'failed' ? String(s.error) : null
    },
    { name: `${name}.fault` },
  )
  // Only a whole answer dates what is held. A piece of one leaves this at
  // zero, and whoever waits on it — an optimistic write waiting to be taken
  // back by the world's own version — waits, which is the right answer.
  const asked = derived(
    () => {
      const held = heldOf(state.get())
      return held !== undefined && held.value.whole ? held.value.askedAt : 0
    },
    { name: `${name}.asked` },
  )
  return {
    tally: feed.tally,
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

/**
 * What the world says, asked for once and kept fresh by its passport.
 *
 * A long ask may report as it goes: the body is handed `soFar` beside the
 * abort signal, and every value it puts down is a real answer — a count over
 * part of a log is a count. Bodies that ignore both arguments are the common
 * case and keep working exactly as before.
 */
export function truth<T>(
  ask: (asked: { signal: AbortSignal; soFar: (value: T) => void }) => Promise<T>,
  passport: TruthPassport<T>,
): Truth<T> {
  const name = passport.name ?? 'truth'
  // One clock. A passport that hands in its own is handing it in for every
  // moment this records, not for some of them.
  const now = passport.now ?? Date.now
  const feed = supply<Carried<T>>(
    async ({ signal, soFar }) => {
      const askedAt = now()
      return {
        value: await ask({
          signal,
          soFar: value => soFar({ value, askedAt, whole: false }),
        }),
        askedAt,
        whole: true,
      }
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

/**
 * Keyed truth: the same door, a family behind it.
 *
 * The key is the question, so changing it calls the old run off — which is
 * how a long run is cancelled without anybody writing cancellation. As with
 * `truth`, the body may report as it goes.
 */
/** A keyed truth: a truth per key, and one tally for the question. */
export interface TruthBy<K, T> {
  (key: K): Truth<T>
  /** What the question has done across every key it was asked with. */
  readonly tally: Tally
}

export function truthBy<K, T>(
  ask: (key: K, asked: { signal: AbortSignal; soFar: (value: T) => void }) => Promise<T>,
  passport: TruthPassport<T>,
): TruthBy<K, T> {
  const name = passport.name ?? 'truth'
  const now = passport.now ?? Date.now
  const family = query<K, Carried<T>>(
    async (key: K, { signal, soFar }) => {
      const askedAt = now()
      return {
        value: await ask(key, {
          signal,
          soFar: value => soFar({ value, askedAt, whole: false }),
        }),
        askedAt,
        whole: true,
      }
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
  // Keyed by the source instance, not by the business key. The family under
  // this wrapper already answers "which source for which key" and evicts
  // unwatched sources past its ceiling; a second cache keyed by the key would
  // duplicate that answer and then disagree with it — growing without bound,
  // and handing out a face wired to a source the family had already let go,
  // which asks the world nothing ever again. A weak map keyed by the source
  // follows the family's decisions for free: evicted source, collected face;
  // same source, same face.
  const faces = new WeakMap<object, Truth<T>>()
  const byKey = (key: K): Truth<T> => {
    const feed = family(key)
    const known = faces.get(feed)
    if (known !== undefined) return known
    // The family's counters, not this member's: a run called off because the
    // key changed belongs to the question, and the key that replaced it never
    // saw it happen.
    const face = faceOf(
      { state: feed.state, tally: family.tally },
      passport.empty,
      () => feed.refresh(),
      `${name}:${JSON.stringify(key)}`,
    )
    faces.set(feed, face)
    return face
  }
  // The tally hangs on the function, not on a member: asking for it used to
  // mean building a truth for a made-up key, which then went and asked the
  // world a question nobody wanted.
  Object.defineProperty(byKey, 'tally', { value: family.tally })
  return byKey as TruthBy<K, T>
}
