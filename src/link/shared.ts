// A shared worker: one graph for every tab of an origin, each tab connected by a
// port of its own. The whole adapter is the two ends of that arrangement.

import { channelOverPort } from './channels.ts'
import type { Port } from './channels.ts'
import type { Channel } from './channel.ts'
import type { Hub } from './bus.ts'

/** What a shared worker's global scope offers: a connection per tab. */
export interface SharedScope {
  addEventListener(kind: 'connect', handler: (event: { ports: readonly Port[] }) => void): void
  removeEventListener(kind: 'connect', handler: (event: { ports: readonly Port[] }) => void): void
}

/** Inside a shared worker: a hub whose arrivals are the tabs connecting. */
export function sharedWorkerHub(scope: SharedScope): Hub {
  return {
    accept(onWatcher) {
      const serving: Array<() => void> = []
      const onConnect = (event: { ports: readonly Port[] }): void => {
        const port = event.ports[0]
        if (port === undefined) return
        serving.push(onWatcher(channelOverPort(port)))
      }
      scope.addEventListener('connect', onConnect)
      return () => {
        scope.removeEventListener('connect', onConnect)
        for (const stop of serving) stop()
        serving.length = 0
      }
    },
  }
}

/** In a tab: the channel to a shared worker. Pass `new SharedWorker(url).port`. */
export function channelToSharedWorker(port: Port): Channel {
  return channelOverPort(port)
}

/** Is a shared worker available here at all? */
export function sharedWorkersExist(): boolean {
  return typeof (globalThis as { SharedWorker?: unknown }).SharedWorker === 'function'
}
