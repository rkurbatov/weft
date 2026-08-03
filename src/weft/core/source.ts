// A source owns delivery: fetching, retrying, polling, and its own pace.
// It runs only while somebody live is watching it — demand starts it, idleness
// stops it — so an unwatched screen costs nothing.

import { cell, input, subscribe, untracked } from './graph.ts'
import type { Watchable } from './graph.ts'
import { owned } from './region.ts'
import type { Readable } from './graph.ts'
import { EMPTY, arrived, heldOf, loading, refused } from './remote.ts'
import type { Fault, Remote } from './remote.ts'
import { wallClock } from './time.ts'
import type { Timers } from './time.ts'

export interface SourceOptions {
  name?: string
  /** Ask again this often while watched. Without it, a source loads once per demand. */
  every?: number
  /**
   * The quiet a look must survive before it becomes a question. A demand that
   * leaves during the wait asks nothing — which is the whole of debounce,
   * stated as a passport property instead of an operator. Pace ticks and
   * refresh() do not wait: the question is not changing there.
   */
  calm?: number
  /** How long an answer stays good. A new demand on a stale answer refetches. */
  shelfLife?: number
  /** Wait before a retry; doubles per failed attempt, capped by retryCap. */
  retry?: number
  retryCap?: number
  /** Random in [0,1) spreading each retry wait (full jitter), so clients
   *  synchronized by a shared outage don't retry in lockstep. Injectable
   *  so tests stay deterministic; defaults to Math.random. */
  jitter?: () => number
  /** The source will not be asked more often than this, however strict a requirement is. */
  floor?: number
  /**
   * No answer within this long is an answer of its own: the outcome is
   * unknown, the ask is broken off, and a late answer is disowned.
   */
  timeout?: number
  /** Name the kind of trouble. Default: Unknown-shaped errors are unknown,
   *  everything else transient. Only transient and unknown are retried by
   *  themselves — a source is a read, and a read is safe to repeat. */
  classify?: (error: unknown) => Fault
  /** Told when a requirement asks for more than the floor allows. */
  onUnmet?: (unmet: { source: string; wanted: number; floor: number }) => void
  now?: () => number
  timers?: Timers
}

export interface Source<T> {
  readonly name: string
  /** The state of what the world said: empty, in flight, value with an age, refused. */
  readonly state: Readable<Remote<T>>
  /** Is anything live watching right now. */
  readonly demanded: boolean
  /** How often the source is asked right now, given every live requirement. Undefined means "once per demand". */
  readonly pace: number | undefined
  /**
   * State a requirement: this value must not be older than `within`. Held for as
   * long as the returned release is uncalled; the strictest live one sets the pace.
   */
  require(within: number): () => void
  /**
   * Put back an answer kept from a previous run, with the moment it originally
   * arrived — so its age is honest and the usual rules decide what to do next.
   * Ignored if anything is already held or in flight.
   */
  restore(value: T, at: number): void
  /**
   * Ask again now, watched or not; the answer already under way, if any, is
   * disowned. Resolves when the fresh answer has landed in the cell.
   */
  refresh(): Promise<void>
}

export function source<T>(
  load: (asked: { signal: AbortSignal }) => Promise<T>,
  options: SourceOptions = {},
): Source<T> {
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

  const state = input<Remote<T>>(EMPTY, {
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

  function backoff(): number | undefined {
    if (retry === undefined) return undefined
    const wait = retry * 2 ** Math.max(0, attempt - 1)
    const capped = retryCap === undefined ? wait : Math.min(wait, retryCap)
    // Full jitter: uniform in (0, capped]. 1 - jitter() keeps the wait
    // strictly positive whatever the injected randomness returns.
    return capped * (1 - jitter())
  }

  function begin(force = false): Promise<void> {
    if (inFlight !== null && !force) return inFlight
    cancel()
    const mine = ++generation
    const controller = new AbortController()
    asking = controller
    let finish!: () => void
    const flight = new Promise<void>(resolve => {
      finish = resolve
    })
    // Claim the slot before touching the cell: writing it wakes watchers, and a
    // waking watcher may ask for this very source again.
    inFlight = flight
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
    void load({ signal: controller.signal })
      .then(
        value => {
          if (mine !== generation) return
          if (guard !== null) timers.clear(guard)
          attempt = 0
          state.set(arrived(value, now()))
          reschedule()
        },
        (error: unknown) => {
          if (mine !== generation) return
          if (guard !== null) timers.clear(guard)
          attempt++
          const fault = classify(error)
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
    refresh: () => begin(true),
  }
}

/**
 * A view of a source that states a requirement while anybody watches it:
 * the demand and the requirement arrive and leave together, so nothing has to
 * be released by hand.
 */
export function fresh<T>(feed: Source<T>, within: number): Readable<Remote<T>> {
  let release: (() => void) | null = null
  const gate = input(0, {
    name: `${feed.name}!${within}`,
    onDemand: () => {
      release = feed.require(within)
    },
    onIdle: () => {
      release?.()
      release = null
    },
  })
  return cell(
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
