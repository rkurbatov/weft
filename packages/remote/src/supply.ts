// A supply owns delivery: fetching, retrying, polling, and its own pace.
// It runs only while somebody live is watching it — demand starts it, idleness
// stops it — so an unwatched screen costs nothing.

import { backoff as doubling } from '#core'
import { derived, port, subscribe, untracked } from '#graph'
import type { Port } from '#graph'
import type { Watchable } from '#graph'
import { owned } from '#graph'
import type { Readable } from '#graph'
import { EMPTY, arrived, heldOf, loading, refused } from './remote.ts'
import type { Fault, Remote } from './remote.ts'
import { wallClock } from '#core'
import type { Supply, SupplyPassport, Tally } from './contract.ts'

export type { Supply, SupplyPassport }

/** The same counters, seen from the inside — where they are written. */
interface MutableTally {
  asked: Port<number>
  answered: Port<number>
  calledOff: Port<number>
  refused: Port<number>
  published: Port<number>
}

/** A set of counters a family can hand to each of its members. */
export function tally(name = 'tally'): Tally {
  return {
    asked: port(0, { name: `${name}.asked` }),
    answered: port(0, { name: `${name}.answered` }),
    calledOff: port(0, { name: `${name}.calledOff` }),
    refused: port(0, { name: `${name}.refused` }),
    published: port(0, { name: `${name}.published` }),
  }
}

export function supply<T>(
  load: (asked: { signal: AbortSignal; soFar: (value: T) => void }) => Promise<T>,
  options: SupplyPassport = {},
): Supply<T> {
  const name = options.name ?? 'source'
  const now = options.now ?? Date.now
  const timers = options.timers ?? wallClock
  const { every, shelfLife, retry, floor, onUnmet, timeout, calm } = options
  const classify =
    options.classify ??
    ((error: unknown): Fault =>
      error instanceof Error && (error.name === 'Unknown' || error.name === 'UnknownOutcome')
        ? 'unknown'
        : 'transient')
  const jitter = options.jitter ?? Math.random
  const retryCap = options.retryCap ?? (retry === undefined ? undefined : retry * 32)

  // Live requirements, one entry per consumer that stated one.
  const wants = new Map<symbol, number>()
  let timer: unknown = null
  let generation = 0
  let attempt = 0
  let inFlight: Promise<void> | null = null
  let asking: AbortController | null = null

  // What this source has done. Plain ports, written on events that happen a
  // few times a second at worst, read like any other cell. A family hands its
  // own in, so its members count into one place.
  const shared = options.tally as MutableTally | undefined
  const tallyAsked = shared?.asked ?? port(0, { name: `${name}.asked` })
  const tallyAnswered = shared?.answered ?? port(0, { name: `${name}.answered` })
  const tallyCalledOff = shared?.calledOff ?? port(0, { name: `${name}.calledOff` })
  const tallyRefused = shared?.refused ?? port(0, { name: `${name}.refused` })
  const tallyPublished = shared?.published ?? port(0, { name: `${name}.published` })

  const state = port<Remote<T>>(EMPTY, {
    name,
    onDemand: () => {
      reschedule()
    },
    onIdle: () => {
      cancel()
      // Cancellation is the loss of demand: nobody wants the answer, so the
      // ask is broken off and whatever limps in later is disowned.
      if (asking !== null) {
        generation++
        inFlight = null
        asking.abort()
        asking = null
      }
    },
  })

  function cancel(): void {
    if (timer === null) return
    timers.clear(timer)
    timer = null
  }

  function schedule(delay: number | undefined): void {
    cancel()
    if (delay === undefined || !state.demanded) return
    timer = timers.set(() => {
      timer = null
      void begin()
    }, delay)
  }

  /** The strictest live requirement, if anyone stated one. */
  function strictest(): number | undefined {
    let best: number | undefined
    for (const within of wants.values()) best = best === undefined ? within : Math.min(best, within)
    return best
  }

  /** How often to ask: the tightest of the declared pace and the live requirements, never below the floor. */
  function pace(): number | undefined {
    const want = strictest()
    const wanted = every === undefined ? want : want === undefined ? every : Math.min(every, want)
    if (wanted === undefined) return undefined
    return floor === undefined ? wanted : Math.max(wanted, floor)
  }

  /** Put the next ask where the current pace and the age of what we hold say it belongs. */
  function reschedule(): void {
    if (!state.demanded) {
      cancel()
      return
    }
    // A pause earned by refusals outlives the loss of demand: what is owed is
    // owed to the server, not to the watcher who happened to be looking.
    const owed = notBefore - now()
    if (owed > 0) {
      schedule(owed)
      return
    }
    if (stale()) {
      if (calm === undefined) void begin()
      else schedule(calm) // the look waits out the quiet; leaving cancels it
      return
    }
    const interval = pace()
    if (interval === undefined) {
      cancel()
      return
    }
    const held = heldOf(state.peek())
    const due = held === undefined ? 0 : held.at + interval - now()
    schedule(Math.max(0, due))
  }

  /** Is what we hold too old to serve the next watcher? */
  function stale(): boolean {
    const held = heldOf(state.peek())
    if (held === undefined) return true
    const age = now() - held.at
    const want = strictest()
    if (want !== undefined && age >= want) return true
    if (shelfLife === undefined) return false
    return age >= shelfLife
  }

  /**
   * The earliest the world may be asked again after a refusal.
   *
   * Kept as a moment, not as a pending timer: a timer dies with the demand,
   * and then a tab switched away and back would ask immediately, however many
   * refusals came before. Flapping between tabs is not a reason to drop the
   * pause a failing server has earned.
   */
  let notBefore = 0

  function backoff(): number | undefined {
    if (retry === undefined) return undefined
    const capped = doubling(attempt, retry, retryCap)
    // Full jitter: uniform in (0, capped]. 1 - jitter() keeps the wait
    // strictly positive whatever the injected randomness returns.
    const wait = capped * (1 - jitter())
    notBefore = now() + wait
    return wait
  }

  function begin(force = false): Promise<void> {
    if (inFlight !== null && !force) return inFlight
    cancel()
    const mine = ++generation
    const controller = new AbortController()
    asking = controller
    // Counted here rather than by whoever wrote the body: the source is what
    // raises the signal, so it is the only place that knows the difference
    // between a run that was called off and one that had already finished when
    // its question was dropped. Counted by hand, it came out wrong both ways.
    let done = false
    controller.signal.addEventListener('abort', () => {
      if (!done) tallyCalledOff.set(tallyCalledOff.peek() + 1)
    })
    let finish!: () => void
    const flight = new Promise<void>(resolve => {
      finish = resolve
    })
    // Claim the slot before touching any cell: writing one wakes watchers, and
    // a waking watcher may ask for this very source again. The counter is a
    // cell like any other, and counting before this line started a second run
    // per demand — caught by a test that had nothing to do with counting.
    inFlight = flight
    tallyAsked.set(tallyAsked.peek() + 1)
    let guard: unknown = null
    if (timeout !== undefined) {
      guard = timers.set(() => {
        if (mine !== generation) return
        // No answer in time. That is not a refusal by the world — the ask may
        // have reached it — so the outcome is unknown, and a late answer
        // must not land over whatever comes next.
        generation++
        inFlight = null
        asking = null
        controller.abort()
        attempt++
        state.set(
          refused(
            state.peek(),
            new Error(`weft: ${name} gave no answer within ${timeout}ms`),
            attempt,
            'unknown',
          ),
        )
        schedule(backoff())
        finish()
      }, timeout)
    }
    state.set(loading(state.peek(), now()))

    /**
     * What the work has so far.
     *
     * A long run — a histogram over a hundred megabytes — is not one answer at
     * the end: every step of it is a real value, and a screen should be able to
     * show it. So the body may put down what it has, as often as it likes, and
     * the last one it puts down is simply the answer until the next.
     *
     * Nothing marks these as unfinished, on purpose. What "partial" means —
     * where the work stopped, whether a budget ran out — is the application's
     * own business, said inside its own value; the library only carries it.
     * A run whose demand has left is disowned like any other: its `soFar` does
     * nothing, so a body that keeps going for a moment cannot write into a
     * question nobody asked.
     */
    const soFar = (value: T): void => {
      if (mine !== generation) return
      tallyPublished.set(tallyPublished.peek() + 1)
      state.set(arrived(value, now()))
    }

    void load({ signal: controller.signal, soFar })
      .then(
        value => {
          if (mine !== generation) return
          if (guard !== null) timers.clear(guard)
          done = true
          tallyAnswered.set(tallyAnswered.peek() + 1)
          tallyPublished.set(tallyPublished.peek() + 1)
          attempt = 0
          notBefore = 0
          state.set(arrived(value, now()))
          reschedule()
        },
        (error: unknown) => {
          if (mine !== generation) return
          if (guard !== null) timers.clear(guard)
          attempt++
          const fault = classify(error)
          done = true
          tallyRefused.set(tallyRefused.peek() + 1)
          state.set(refused(state.peek(), error, attempt, fault))
          // Only what can pass by itself is retried by itself. A source is a
          // read, so unknown is safe to repeat; permanent and rejected lie
          // still until a new demand or an explicit refresh.
          if (fault === 'transient' || fault === 'unknown') schedule(backoff())
        },
      )
      .finally(() => {
        if (mine === generation) {
          inFlight = null
          asking = null
        }
        finish()
      })
    return flight
  }

  function require(within: number): () => void {
    if (floor !== undefined && within < floor) onUnmet?.({ source: name, wanted: within, floor })
    const token = Symbol('requirement')
    wants.set(token, within)
    reschedule()
    return () => {
      if (!wants.delete(token)) return
      reschedule()
    }
  }

  function restore(value: T, at: number): void {
    if (inFlight !== null) return
    if (heldOf(state.peek()) !== undefined) return
    state.set(arrived(value, at))
  }

  // A region taking this source down: the clock stops, the ask in flight is
  // disowned, and nothing arrives late into a dead module.
  owned(() => {
    cancel()
    generation++
    inFlight = null
    if (asking !== null) {
      asking.abort()
      asking = null
    }
  })

  return {
    name,
    state,
    require,
    restore,
    get demanded() {
      return state.demanded
    },
    get pace() {
      return pace()
    },
    tally: {
      asked: tallyAsked,
      answered: tallyAnswered,
      calledOff: tallyCalledOff,
      refused: tallyRefused,
      published: tallyPublished,
    },
    refresh: () => begin(true),
  }
}

/**
 * A view of a source that states a requirement while anybody watches it:
 * the demand and the requirement arrive and leave together, so nothing has to
 * be released by hand.
 */
export function fresh<T>(feed: Supply<T>, within: number): Readable<Remote<T>> {
  let release: (() => void) | null = null
  const gate = port(0, {
    name: `${feed.name}!${within}`,
    onDemand: () => {
      release = feed.require(within)
    },
    onIdle: () => {
      release?.()
      release = null
    },
  })
  return derived(
    () => {
      gate.get()
      return feed.state.get()
    },
    { name: `${feed.name}@${within}` },
  )
}

// The promise of the answer under way. Subscribing is what raises the demand,
// so asking for the promise is what starts the load — nothing is forced and no
// flight is restarted. One promise per source while it is unsettled. Landing
// is a property of the graph, not of any screen library.
const landings = new WeakMap<object, Promise<void>>()

/** Resolves when the source holds a value or a refusal has settled. The first
 *  refusal decides, whatever its sort — what to do next is the caller's
 *  business, usually a boundary offering refresh(). */
export function arrivalOf<T>(feed: { state: Watchable<Remote<T>> }): Promise<void> {
  const settled = (): boolean => {
    const state = untracked(() => feed.state.peek())
    return heldOf(state) !== undefined || state.kind === 'failed'
  }
  if (settled()) return Promise.resolve()
  const known = landings.get(feed)
  if (known !== undefined) return known
  const landing = new Promise<void>(resolve => {
    const stop = subscribe(feed.state, () => {
      if (!settled()) return
      stop()
      landings.delete(feed)
      resolve()
    })
  })
  landings.set(feed, landing)
  return landing
}
