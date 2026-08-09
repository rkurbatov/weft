// The transport: what carries messages, and nothing else.
//
// A broadcast line carries an object to everybody listening on it —
// `BroadcastChannel` in a browser, the same thing from `node:worker_threads` in
// a test, a pair of functions in a unit test. It knows nothing about who the
// message is for, what is inside it, or that a graph exists: addressing and the
// protocol live one floor up, in `postbox.ts`.
//
// Keeping this apart is what makes a new transport cheap — write the four
// methods and everything above works unchanged — and what lets the protocol be
// tested without a browser anywhere in sight.

export interface Broadcast {
  post(message: unknown): void
  /** Returns the way to stop listening. */
  on(handler: (message: unknown) => void): () => void
  close(): void
}

/** Anything shaped like a BroadcastChannel: the browser's, or Node's own. */
export interface BusLike {
  postMessage(message: unknown): void
  addEventListener(kind: 'message', handler: (event: { data: unknown }) => void): void
  removeEventListener(kind: 'message', handler: (event: { data: unknown }) => void): void
  close(): void
}

/**
 * A broadcast line over anything BroadcastChannel-shaped.
 *
 * The `targetOrigin` lint rule is off for the repository because of this call
 * and the ones in `wires.ts`: it is written for `window.postMessage`, where an
 * origin is a security boundary. A broadcast channel and a message port take
 * no such argument — everything on a channel is same-origin by construction —
 * so the rule has nothing true to say about any `postMessage` in this library.
 */
export function overBus(bus: BusLike): Broadcast {
  return {
    post: message => bus.postMessage(message),
    on(handler) {
      const onMessage = (event: { data: unknown }): void => handler(event.data)
      bus.addEventListener('message', onMessage)
      return () => bus.removeEventListener('message', onMessage)
    },
    close: () => bus.close(),
  }
}

/** A broadcast line on this origin, opened by name. */
export function openBroadcast(name: string): Broadcast {
  const make = (globalThis as { BroadcastChannel?: new (name: string) => BusLike }).BroadcastChannel
  if (make === undefined) throw new Error('weft: no BroadcastChannel here')
  return overBus(new make(name))
}

/**
 * A broadcast line in memory: everything posted reaches every listener,
 * including the one that posted it — exactly as a real bus behaves, which is
 * why the protocol above needs addressing at all.
 */
export function localBroadcast(): Broadcast {
  const listeners = new Set<(message: unknown) => void>()
  return {
    post(message) {
      // A copy of the set on purpose: a listener may stop listening while being told.
      const told = Array.from(listeners)
      for (const listener of told) listener(message)
    },
    on(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
    close: () => listeners.clear(),
  }
}
