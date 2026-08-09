// One doubling, three doors.
//
// The retry curve — a base delay doubled per failed attempt, under a ceiling —
// was written out by hand in the outbox scheduler, the source loader and the
// reconciler, three copies of one piece of arithmetic that had to agree and
// had no way of knowing about each other. The arithmetic lives here; whether
// jitter is spread over it stays each caller's own decision, because a shared
// primitive that also decided randomness would make its tests lie.

/**
 * How long to wait before the given attempt: `base`, doubled per failure,
 * never above `cap`. The first attempt (0 or 1) waits the base itself.
 */
export const backoff = (attempt: number, base: number, cap: number = Infinity): number =>
  Math.min(base * 2 ** Math.max(0, attempt - 1), cap)
