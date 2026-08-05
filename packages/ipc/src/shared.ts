// A shared worker: one graph for every tab of an origin, each tab connected by a
// port of its own. The whole adapter is the two ends of that arrangement.
//
// A closed tab does not close its port — nothing on the worker's side ever
// fires. So the hub holds each tab by a lease, renewed by anything the tab
// says; the tab's channel keeps a heartbeat while somebody listens on it.

import { portChannel } from './ports.ts'
import type { Port } from './ports.ts'
import type { Channel } from './channel.ts'
import { heartbeat, KEEP_ALIVE, LEASE } from './bus.ts'
import { greeting, isGreeting } from './postbox.ts'
import type { Hub, HubOptions, KeepAliveOptions } from './bus.ts'
import { wallClock } from '#graph/graph/time.ts'

/** A port carries one tab only, so the greeting needs no claim of its own. */
const GREETING = greeting(undefined)

/** What a shared worker's global scope offers: a connection per tab. */
export interface SharedScope {
  addEventListener(kind: 'connect', handler: (event: { ports: readonly Port[] }) => void): void
  removeEventListener(kind: 'connect', handler: (event: { ports: readonly Port[] }) => void): void
}

/** Inside a shared worker: a hub whose arrivals are the tabs connecting. */
export function sharedWorkerHub(scope: SharedScope, options: HubOptions = {}): Hub {
  const lease = options.lease ?? LEASE
  const timers = options.timers ?? wallClock
  return {
    accept(onWatcher) {
      const serving = new Map<Port, { stop: () => void; held?: unknown }>()

      const drop = (port: Port): void => {
        const entry = serving.get(port)
        if (entry === undefined) return
        if (entry.held !== undefined) timers.clear(entry.held)
        entry.stop()
        serving.delete(port)
      }

      const renew = (port: Port): void => {
        if (lease === false) return
        const entry = serving.get(port)
        if (entry === undefined) return
        if (entry.held !== undefined) timers.clear(entry.held)
        entry.held = timers.set(() => drop(port), lease)
      }

      const onConnect = (event: { ports: readonly Port[] }): void => {
        const port = event.ports[0]
        if (port === undefined) return
        const raw = portChannel(port)
        const channel: Channel = {
          send: raw.send,
          // The heartbeat is transport talk: it renews the lease and goes no further.
          listen: handler =>
            raw.listen(message => {
              renew(port)
              if (!isGreeting(message)) handler(message)
            }),
        }
        serving.set(port, { stop: onWatcher(channel) })
        renew(port)
      }

      scope.addEventListener('connect', onConnect)
      return () => {
        scope.removeEventListener('connect', onConnect)
        // Snapshot: drop() deletes from `serving` while we walk it.
        // oxlint-disable-next-line unicorn/no-useless-spread
        for (const port of [...serving.keys()]) drop(port)
      }
    },
  }
}

/** In a tab: the channel to a shared worker. Pass `new SharedWorker(url).port`. */
export function sharedWorkerChannel(port: Port, options: KeepAliveOptions = {}): Channel {
  const keepAlive = options.keepAlive ?? KEEP_ALIVE
  const timers = options.timers ?? wallClock
  const raw = portChannel(port)
  return {
    send: raw.send,
    listen: handler => {
      const stop = raw.listen(handler)
      const stopBeating = heartbeat(() => raw.send(GREETING), keepAlive, timers)
      return () => {
        stop()
        stopBeating()
      }
    },
  }
}

/** Is a shared worker available here at all? */
export function sharedWorkersExist(): boolean {
  return typeof (globalThis as { SharedWorker?: unknown }).SharedWorker === 'function'
}
