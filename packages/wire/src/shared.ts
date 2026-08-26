// A shared worker: one graph for every tab of an origin, each tab connected by a
// port of its own. The whole adapter is the two ends of that arrangement.
//
// A closed tab does not close its port — nothing on the worker's side ever
// fires. So the hub holds each tab by a lease, renewed by anything the tab
// says; the tab's channel keeps a heartbeat while somebody listens on it.

import { overWire } from './wires.ts'
import type { Wire } from './wires.ts'
import type { Channel } from './channel.ts'
import { heartbeat, KEEP_ALIVE, LEASE } from './bus.ts'
import { claimOf, greeting, isGreeting, PROTOCOL, protocolOf } from './postbox.ts'
import type { ChannelOptions, Hub, HubOptions } from './bus.ts'
import { wallClock } from '#graph'

/** What a shared worker's global scope offers: a connection per tab. */
export interface SharedScope {
  addEventListener(kind: 'connect', handler: (event: { ports: readonly Wire[] }) => void): void
  removeEventListener(kind: 'connect', handler: (event: { ports: readonly Wire[] }) => void): void
}

/**
 * Inside a shared worker: a hub whose arrivals are the tabs connecting.
 *
 * A port is a private line, which is why this took a channel from whoever
 * connected and asked nothing. But private is not the same as ours: one shared
 * worker serves every tab of an origin, and those tabs can be running two
 * builds and belong to two people. So a port is admitted on the same terms the
 * bus admits a name — it greets, its protocol is checked, its claim is put to
 * `admit` — and until it is admitted it is handed no channel and hears no
 * state. A refusal is said out loud, because a silent wire and a broken one
 * look the same from a tab.
 */
export function sharedWorkerHub(scope: SharedScope, options: HubOptions = {}): Hub {
  const lease = options.lease ?? LEASE
  const timers = options.timers ?? wallClock
  const admit = options.admit
  return {
    accept(onWatcher) {
      /** Every connected port, admitted or not: the raw listener holding it. */
      const listening = new Map<Wire, () => void>()
      /** Admitted ports only: what the graph side gave us, and the lease. */
      const serving = new Map<Wire, { stop: () => void; held?: unknown }>()

      const drop = (port: Wire): void => {
        const entry = serving.get(port)
        if (entry !== undefined) {
          if (entry.held !== undefined) timers.clear(entry.held)
          entry.stop()
          serving.delete(port)
        }
        listening.get(port)?.()
        listening.delete(port)
      }

      const renew = (port: Wire): void => {
        if (lease === false) return
        const entry = serving.get(port)
        if (entry === undefined) return
        if (entry.held !== undefined) timers.clear(entry.held)
        entry.held = timers.set(() => drop(port), lease)
      }

      const onConnect = (event: { ports: readonly Wire[] }): void => {
        const port = event.ports[0]
        if (port === undefined) return
        const raw = overWire(port)
        let hand: ((message: unknown) => void) | undefined
        let turned = false

        const refuse = (why: string): void => {
          turned = true
          raw.send({ kind: 'refused', why })
        }

        const channel: Channel = {
          send: raw.send,
          listen: handler => {
            hand = handler
            return () => {
              hand = undefined
            }
          },
        }

        const stop = raw.listen(message => {
          if (turned) return
          // The heartbeat is transport talk: it renews the lease and, the first
          // time, decides whether there is a lease to renew at all.
          if (isGreeting(message)) {
            if (!serving.has(port)) {
              const theirs = protocolOf(message)
              if (theirs !== PROTOCOL) {
                // A tab from another build. Say which versions met, so the
                // answer is "reload the page", not a hunt through the protocol.
                refuse(
                  `this station speaks protocol ${PROTOCOL}, the tab speaks ${theirs ?? 'none'}`,
                )
                return
              }
              if (admit !== undefined && !admit(claimOf(message))) {
                // Somebody else's tab. A replica handed to the wrong session is
                // a leak, and one shared worker serves every tab of an origin.
                refuse(`not this station's session`)
                return
              }
              serving.set(port, { stop: onWatcher(channel) })
            }
            renew(port)
            return
          }
          // Anything before a greeting is a tab that did not introduce itself.
          // A port keeps order, so this is a build that does not handshake,
          // not a race.
          if (!serving.has(port)) {
            refuse('a tab must greet before it is served')
            return
          }
          renew(port)
          hand?.(message)
        })
        listening.set(port, stop)
      }

      scope.addEventListener('connect', onConnect)
      return () => {
        scope.removeEventListener('connect', onConnect)
        // Snapshot: drop() deletes from the maps while we walk them.
        // oxlint-disable-next-line unicorn/no-useless-spread
        for (const port of [...listening.keys()]) drop(port)
      }
    },
  }
}

/**
 * In a tab: the channel to a shared worker. Pass `new SharedWorker(url).port`.
 *
 * The greeting goes out at once rather than on the first beat: it is what asks
 * to be served, and everything this tab says afterwards is refused until it is
 * answered.
 */
export function sharedWorkerChannel(port: Wire, options: ChannelOptions = {}): Channel {
  const keepAlive = options.keepAlive ?? KEEP_ALIVE
  const timers = options.timers ?? wallClock
  const raw = overWire(port)
  const hello = greeting(options.claim)
  return {
    send: raw.send,
    listen: handler => {
      const stop = raw.listen(handler)
      raw.send(hello)
      const stopBeating = heartbeat(() => raw.send(hello), keepAlive, timers)
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
