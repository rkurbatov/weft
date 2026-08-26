// The assembly word: one line instead of a page of wiring.
//
// Everything below already existed — a pair of channels, a station serving a
// surface, a link mirroring it, a lock electing one tab to do the work. What
// did not exist was a word that puts them together, so every page wrote the
// same twenty lines by hand and every one of them had to know about workers,
// pairs, hubs and locks to say a thing that has nothing to do with any of it:
// "the state lives over there, and this screen is a window onto it".
//
// `loom(spec, { wire })` says exactly that. Where the state lives is the one
// decision left to make, and it is made by naming a wire:
//
//   loom({ name, station }, { wire: inMemory() })   same thread, no crossing
//   loom({ name, station }, { wire: tabs() })       one tab works, others mirror
//   loom({ name },         { wire: worker(w) })     the station is in a worker
//
// The worker case takes no station, and that is not an omission: the station
// is built inside the worker, by the worker's own `offer`. A spec that hands
// one in for a worker would be describing something that never runs here.

import { port } from '#weft'
import type { Channel, Watchable } from '#weft'
import { overWire } from '#weft'
import type { Lock } from '#wire'
import { adopt, carry, facing, offer } from './carry.ts'
import type { Adopted, Face, Offering, OfferOptions } from './carry.ts'
import { notice } from '#core'

/** Where the state lives, and who is doing the work. */
export type Role = 'inline' | 'leading' | 'following'

export interface Station<O extends Offering = Offering> {
  serve: (channel: Channel) => () => void
  dispose?: () => void
  /**
   * What this station offers. A type, not a value — it is never read at run
   * time and never crosses the wire; it is here so the names and shapes
   * declared on the station reach the screens that read them.
   */
  readonly offering?: O
}

/**
 * Declare a station from what it offers.
 *
 * `serve` and `dispose` written by hand is the whole of what a station was,
 * which meant the offering — the one thing a screen needs to know — was buried
 * inside a closure and lost to the compiler. Said here, it is kept.
 */
export function station<O extends Offering>(
  handles: O,
  options: OfferOptions & { dispose?: () => void } = {},
): Station<O> {
  const { dispose, ...serving } = options
  return {
    serve: channel => offer(handles, channel, serving),
    ...(dispose === undefined ? {} : { dispose }),
  }
}

export interface LoomSpec<O extends Offering = Offering> {
  /** The name in the instruments, and the word this screen is elected by. */
  name: string
  /**
   * The application's durable identity — what its shelf is filed under.
   *
   * Apart from `name` on purpose. `name` is diagnostic: it is renamed to read
   * better in a log, and a rename that quietly moves a book of unsent intents
   * to a new key and abandons the old one is not a rename anybody meant to
   * make. Absent, `name` is used, which is right until the day it is renamed —
   * state it the moment the shelf matters.
   */
  app?: string
  /**
   * Who is signed in.
   *
   * Said once, here, and it partitions two things at once: the shelf — a book
   * of unsent intents outlives the tab, so it is filed under app and session
   * and nobody else can reach it — and the placement. Tabs elect one of
   * themselves to do the work; two sessions of one application hold separate
   * elections and raise stations of their own, rather than one leading and
   * handing the other its whole screen.
   *
   * Absent, nothing durable opens itself and says so.
   */
  session?: string
  /** Build the station. Called only where it comes to live — never in a tab
   *  that ends up following, and never on the panel side of a worker. */
  station?: () => Station<O>
}

/** How this screen reaches the state. */
export interface Wiring {
  kind: 'inline' | 'tabs' | 'worker'
  /** The worker's end, for `worker()`. */
  channel?: Channel
  /** The lock to elect with; tests hand in their own. */
  lock?: Lock
}

/** Same thread: the station is built here and talked to over a pair. */
export function inMemory(): Wiring {
  return { kind: 'inline' }
}

/**
 * Tabs: whichever tab holds the lock builds the station and serves the others.
 *
 * A tab that arrives later mirrors instead of computing, and if the working tab
 * closes, one of the rest takes over — the screens do not notice.
 */
export function tabs(options: { lock?: Lock } = {}): Wiring {
  return { kind: 'tabs', ...(options.lock === undefined ? {} : { lock: options.lock }) }
}

/** A worker: the station lives there, this side only mirrors. */
export function worker(target: Parameters<typeof overWire>[0]): Wiring {
  return { kind: 'worker', channel: overWire(target) }
}

export interface Loomed<O extends Offering = Offering> extends Adopted {
  /**
   * The station's face: `app.face.views.seats`, `app.face.acts.take()`, checked against
   * what the station declared. The untyped `view(name)` and `act(name)` stay
   * below for names built at run time.
   */
  readonly face: Face<O>
  /** Where the work is happening: here alone, here for everybody, or elsewhere. */
  readonly role: Watchable<Role>
  /** Let go of the wire, and of the station if this side is holding it. */
  stop(): void
}

export function loom<O extends Offering = Offering>(
  spec: LoomSpec<O>,
  options: { wire?: Wiring } = {},
): Loomed<O> {
  // The common case is the state living right here; saying so is a line that
  // carries no decision, and a line that carries no decision is noise.
  const wiring = options.wire ?? inMemory()

  if (wiring.kind === 'worker') {
    if (spec.session !== undefined) {
      // The station is built inside the worker, by the worker's own entry
      // point, so there is nothing here to build under an owner. Saying who is
      // signed in on this side would look like it took effect and would not.
      notice({
        kind: 'session-in-worker',
        where: spec.name,
        level: 'warn',
        message: `loom(${spec.name}): the station lives in the worker, so its owner is named there — the session given here does nothing`,
      })
    }
    const channel = wiring.channel as Channel
    const face = adopt(channel)
    // Always 'following': the work is on the other side of the wire, and this
    // side could not take it over even if it wanted to.
    const role = port<Role>('following', { name: `${spec.name}.role` })
    return {
      ...face,
      face: facing<O>(face),
      role,
      stop: () => {
        face.close()
        channel.close?.()
      },
    }
  }

  if (spec.station === undefined) {
    throw new Error(`loom(${spec.name}): a station is needed for ${wiring.kind}`)
  }

  const owner =
    spec.session === undefined ? undefined : { app: spec.app ?? spec.name, session: spec.session }
  const carried = carry(
    {
      name: spec.name,
      // Handed down rather than wrapped here: the owner has to hold for the
      // election and the bus as well as for the building, and a tab that is
      // handed the lock minutes later has to be raised under the same one.
      ...(owner === undefined ? {} : { owner }),
      station: spec.station,
    },
    {
      mode: wiring.kind,
      ...(wiring.lock === undefined ? {} : { lock: wiring.lock }),
    },
  )
  const face = adopt(carried.channel)
  return {
    ...face,
    face: facing<O>(face),
    role: carried.role,
    stop: () => {
      face.close()
      carried.stop()
    },
  }
}
