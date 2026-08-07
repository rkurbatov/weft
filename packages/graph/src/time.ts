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
 * arrive, and — the whole point — let a message from another thread be heard.
 * Written out by hand it comes to `await new Promise(r => setTimeout(r, 0))`,
 * which is ugly in every loop that needs it and slow besides: browsers clamp
 * nested timeouts to four milliseconds, so eighty chunks pay a third of a
 * second for nothing.
 *
 * A message task is what is used instead — the standard way of asking for a
 * turn without the clamp, and about seven times cheaper than a timeout.
 *
 * `scheduler.yield()` is deliberately NOT used, though it exists for exactly
 * this and is faster still. Its whole feature is that the continuation goes
 * ahead of tasks queued while you waited — which means a worker searching a
 * corpus never hears the message telling it to stop, because its own
 * continuation keeps overtaking it. The run then finishes work nobody wants,
 * and the abort arrives after the answer. Found by a demo where cancelling a
 * search worked in Node and never worked in the browser.
 *
 * Measured, per yield: timeout 1170 μs, message task 162 μs, setImmediate
 * 10 μs.
 */
export function giveWay(): Promise<void> {
  // Node: a check-phase callback, which runs after pending I/O — messages from
  // other threads included.
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
