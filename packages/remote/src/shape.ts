// What a source is: its passport and its surface.
//
// The passport is the whole of the policy — pace, freshness, deadline,
// retries, how many at once — and it is declared where the source is, not at
// the call site. Apart from the machinery so that it can be read as a list of
// decisions rather than hunted for inside a closure.

import type { Readable, Watchable } from '#graph'
import type { Timers } from '#graph/time.ts'
import type { Fault, Remote } from './remote.ts'

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
