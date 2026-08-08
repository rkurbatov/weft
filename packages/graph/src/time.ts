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
let waiting: Array<() => void> | null = null
let port: MessagePort | null = null
let hearing: MessagePort | null = null

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
    // One channel for the module, not one per call. A channel is a platform
    // object, dear to make and dearer to collect — and the whole point of
    // this function is to sit inside loops that run thousands of times. All
    // the turns waited for in one moment are woken by one message: each of
    // them asked to let the queued tasks run first, and by the time the
    // message is heard, they have been.
    if (waiting === null) {
      waiting = []
      const channel = new Channel()
      port = channel.port2
      hearing = channel.port1
      channel.port1.addEventListener('message', () => {
        const woken = waiting as Array<() => void>
        waiting = []
        // Idle again: in a Node-like process a held port holds the door, and
        // an idle wake channel must not keep the process alive. A browser has
        // no `ref`/`unref`, and no such worry either.
        ;(hearing as { unref?: () => void } | null)?.unref?.()
        for (const resolve of woken) resolve()
      })
      channel.port1.start()
      ;(channel.port1 as { unref?: () => void }).unref?.()
      ;(channel.port2 as { unref?: () => void }).unref?.()
    }
    return new Promise<void>(resolve => {
      const turns = waiting as Array<() => void>
      if (turns.length === 0) {
        // Somebody is now waiting on the channel: the door is held until the
        // wake is delivered, or the process would end mid-yield.
        ;(hearing as { ref?: () => void } | null)?.ref?.()
        port?.postMessage(null)
      }
      turns.push(resolve)
    })
  }

  return new Promise<void>(resolve => setTimeout(resolve, 0))
}
