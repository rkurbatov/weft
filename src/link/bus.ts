// A bus between tabs of one origin. `BroadcastChannel` carries everything to
// everybody, so the envelope adds who it is from and who it is for; each end
// keeps only what belongs to it.
//
// The graph's side is a hub rather than a channel: several tabs may be watching
// at once, and each of them gets a channel of its own.

import type { Channel } from './channel.ts'

/** A place new watchers arrive at. Each one is handed its own channel. */
export interface Hub {
  /** `onWatcher` is called per arrival and returns the way to stop serving that one. */
  accept(onWatcher: (channel: Channel) => () => void): () => void
}

interface Envelope {
  readonly weft: true
  readonly from: string
  readonly to: string | 'graph' | 'all'
  readonly body: unknown
}

const HELLO = { hello: true } as const

function isEnvelope(message: unknown): message is Envelope {
  return typeof message === 'object' && message !== null && (message as Envelope).weft === true
}

function newName(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return (
    crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  )
}

/** Anything shaped like a BroadcastChannel: the browser's, or Node's own. */
export interface Bus {
  postMessage(message: unknown): void
  addEventListener(kind: 'message', handler: (event: { data: unknown }) => void): void
  removeEventListener(kind: 'message', handler: (event: { data: unknown }) => void): void
  close(): void
}

function openBus(name: string): Bus {
  const make = (globalThis as { BroadcastChannel?: new (name: string) => Bus }).BroadcastChannel
  if (make === undefined) throw new Error('weft: no BroadcastChannel here')
  return new make(name)
}

/** The graph's side of a bus: a hub that hands out one channel per watcher. */
export function busHub(name: string, bus: Bus = openBus(name)): Hub {
  const me = 'graph'
  return {
    accept(onWatcher) {
      const serving = new Map<string, () => void>()
      const handlers = new Map<string, (message: unknown) => void>()

      const onMessage = (event: { data: unknown }): void => {
        const envelope = event.data
        if (!isEnvelope(envelope) || envelope.to !== me) return
        const them = envelope.from

        if (!serving.has(them)) {
          // A tab we have not met: give it a channel of its own.
          const channel: Channel = {
            send: body => bus.postMessage({ weft: true, from: me, to: them, body }),
            listen: handler => {
              handlers.set(them, handler)
              return () => handlers.delete(them)
            },
          }
          serving.set(them, onWatcher(channel))
        }
        if (envelope.body !== undefined && !isHello(envelope.body)) {
          handlers.get(them)?.(envelope.body)
        }
      }

      bus.addEventListener('message', onMessage)

      return () => {
        bus.removeEventListener('message', onMessage)
        for (const stop of serving.values()) stop()
        serving.clear()
        handlers.clear()
      }
    },
  }
}

function isHello(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { hello?: true }).hello === true
}

/** A watcher's side of a bus. Says hello, so the hub knows to serve it. */
export function channelOverBus(name: string, bus: Bus = openBus(name)): Channel {
  const me = newName()
  const send = (body: unknown): void => {
    bus.postMessage({ weft: true, from: me, to: 'graph', body })
  }
  send(HELLO)
  return {
    send,
    listen: handler => {
      const onMessage = (event: { data: unknown }): void => {
        const envelope = event.data
        if (!isEnvelope(envelope) || envelope.to !== me) return
        handler(envelope.body)
      }
      bus.addEventListener('message', onMessage)
      return () => bus.removeEventListener('message', onMessage)
    },
  }
}
