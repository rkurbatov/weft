// Time, injectable. Tests hand in timers of their own and move time by hand;
// everything else gets the wall clock without asking.
//
// In the machine room rather than in the graph: four packages above need to be
// handed a clock — sources poll, the outbox waits, the wire keeps leases — and
// none of that is the graph's business. Nothing here reaches outside: a
// `Timers` never crosses the front door.

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export const wallClock: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}
