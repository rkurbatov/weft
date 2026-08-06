// Time, injectable. Tests hand in timers of their own and move time by hand;
// everything else gets the wall clock without asking.

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export const wallClock: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Give the event loop a turn.
 *
 * What a long run has to do between chunks: let the page paint, let a click
 * arrive, let an abort be heard. Written out by hand it comes to
 * `await new Promise(resolve => setTimeout(resolve, 0))` — which is both ugly
 * in every loop that needs it and wrong: browsers clamp nested timeouts to
 * four milliseconds, so eighty chunks pay a third of a second for nothing.
 *
 * What is used instead, in order of preference:
 *
 * `scheduler.yield()` where it exists — the browser's own answer, which also
 * puts the continuation ahead of newly queued tasks, so a run that yields does
 * not go to the back of a queue it keeps filling.
 *
 * `setImmediate` where it exists — Node, ten microseconds a turn.
 *
 * A `MessageChannel` message otherwise — the standard way of asking for a task
 * without the clamp, and about seven times cheaper than a timeout.
 *
 * Measured, on this machine, per yield: timeout 1170 μs, channel 162 μs,
 * immediate 10 μs.
 */
export function giveWay(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (typeof scheduler?.yield === 'function') return scheduler.yield()

  const immediately = (globalThis as { setImmediate?: (fn: () => void) => unknown }).setImmediate
  if (typeof immediately === 'function') {
    return new Promise<void>(resolve => {
      immediately(resolve)
    })
  }

  const Channel = (globalThis as { MessageChannel?: new () => MessageChannel }).MessageChannel
  if (Channel !== undefined) {
    return new Promise<void>(resolve => {
      const channel = new Channel()
      channel.port1.addEventListener('message', () => {
        channel.port1.close()
        channel.port2.close()
        resolve()
      })
      channel.port1.start()
      channel.port2.postMessage(null)
    })
  }

  return new Promise<void>(resolve => setTimeout(resolve, 0))
}
