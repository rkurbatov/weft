// Where a channel comes from. The pair in memory is for tests and for running
// the graph in the same thread; the port one covers a browser worker and any
// message port that behaves like one.

import type { Channel } from './channel.ts'

export interface Pair {
  graph: Channel
  watcher: Channel
}

/**
 * Two ends in one process. Messages are cloned on the way, exactly as a real
 * boundary would clone them, so a value that could not survive the crossing
 * fails here too rather than in the browser.
 */
export function pairInMemory(clone: boolean = true): Pair {
  const listeners: { graph: Set<(m: unknown) => void>; watcher: Set<(m: unknown) => void> } = {
    graph: new Set(),
    watcher: new Set(),
  }

  const deliver = (to: keyof typeof listeners, message: unknown): void => {
    const sent = clone ? structuredClone(message) : message
    // A copy on purpose: a listener may stop listening while being told.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const listener of [...listeners[to]]) listener(sent)
  }

  const end = (mine: keyof typeof listeners, theirs: keyof typeof listeners): Channel => ({
    send: message => deliver(theirs, message),
    listen: handler => {
      listeners[mine].add(handler)
      return () => listeners[mine].delete(handler)
    },
  })

  return { graph: end('graph', 'watcher'), watcher: end('watcher', 'graph') }
}

/** Anything that posts and receives messages: a Worker, a MessagePort, `self`. */
export interface Port {
  postMessage(message: unknown): void
  addEventListener(kind: 'message', handler: (event: { data: unknown }) => void): void
  removeEventListener(kind: 'message', handler: (event: { data: unknown }) => void): void
  start?(): void
}

export function portChannel(port: Port): Channel {
  port.start?.()
  return {
    send: message => port.postMessage(message),
    listen: handler => {
      const onMessage = (event: { data: unknown }): void => handler(event.data)
      port.addEventListener('message', onMessage)
      return () => port.removeEventListener('message', onMessage)
    },
  }
}
