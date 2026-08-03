// A bus between tabs of one origin. `BroadcastChannel` carries everything to
// everybody, so the envelope adds who it is from and who it is for; each end
// keeps only what belongs to it.
//
// The graph's side is a hub rather than a channel: several tabs may be watching
// at once, and each of them gets a channel of its own.

import type { Channel } from './channel.ts'
import { wallClock } from '../core/time.ts'
import type { Timers } from '../core/time.ts'

/** A place new watchers arrive at. Each one is handed its own channel. */
export interface Hub {
  /** `onWatcher` is called per arrival and returns the way to stop serving that one. */
  accept(onWatcher: (channel: Channel) => () => void): () => void
}

export interface HubOptions {
  /**
   * How long a silent tab stays served. A tab that dies cannot say goodbye, so
   * without this the hub would hold its watches — and their demand — forever.
   * `false` turns the lease off. Any message renews it; watchers keep theirs
   * alive by speaking up (see `keepAlive`).
   */
  lease?: number | false
  timers?: Timers
}

export interface KeepAliveOptions {
  /** Say something this often, so the hub's lease on us never runs out. */
  keepAlive?: number | false
  timers?: Timers
}

export const LEASE = 15_000
export const KEEP_ALIVE = 5_000

/**
 * The heartbeat, with a fast introduction: the first beats come within a
 * fraction of a second and slow down to the settled pace. A newborn channel
 * whose first words were lost — a hub not yet born, a race at page start —
 * must not wait a full settled beat to be met.
 */
export function heartbeat(say: () => void, keepAlive: number | false, timers: Timers): () => void {
  if (keepAlive === false) return () => {}
  let held: unknown
  let pace = Math.min(200, keepAlive)
  const beat = (): void => {
    say()
    pace = Math.min(pace * 2, keepAlive)
    held = timers.set(beat, pace)
  }
  held = timers.set(beat, pace)
  return () => {
    if (held !== undefined) timers.clear(held)
  }
}

interface Envelope {
  readonly weft: true
  readonly from: string
  readonly to: string | 'graph' | 'all'
  readonly body: unknown
}

export const HELLO = { hello: true } as const

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
export function busHub(name: string, bus?: Bus, options: HubOptions = {}): Hub {
  const owned = bus === undefined
  const line = bus ?? openBus(name)
  const me = 'graph'
  const lease = options.lease ?? LEASE
  const timers = options.timers ?? wallClock
  return {
    accept(onWatcher) {
      const serving = new Map<string, { stop: () => void; held?: unknown }>()
      const handlers = new Map<string, (message: unknown) => void>()

      const drop = (them: string): void => {
        const entry = serving.get(them)
        if (entry === undefined) return
        if (entry.held !== undefined) timers.clear(entry.held)
        entry.stop()
        serving.delete(them)
        handlers.delete(them)
      }

      const renew = (them: string): void => {
        if (lease === false) return
        const entry = serving.get(them)
        if (entry === undefined) return
        if (entry.held !== undefined) timers.clear(entry.held)
        entry.held = timers.set(() => drop(them), lease)
      }

      const onMessage = (event: { data: unknown }): void => {
        const envelope = event.data
        if (!isEnvelope(envelope) || envelope.to !== me) return
        const them = envelope.from

        if (!serving.has(them)) {
          // A tab we have not met — or one whose lease ran out and who is back:
          // give it a channel of its own. Its serve announces itself, so a
          // returning watcher re-asks for everything on its own accord.
          const channel: Channel = {
            send: body => line.postMessage({ weft: true, from: me, to: them, body }),
            listen: handler => {
              handlers.set(them, handler)
              return () => handlers.delete(them)
            },
          }
          serving.set(them, { stop: onWatcher(channel) })
        }
        renew(them)
        if (envelope.body !== undefined && !isHello(envelope.body)) {
          handlers.get(them)?.(envelope.body)
        }
      }

      line.addEventListener('message', onMessage)
      // Say we are here to the whole bus at once: watchers that outlived the
      // last graph re-ask immediately instead of waiting out their heartbeat,
      // and their watches introduce them before any command of theirs flies.
      line.postMessage({ weft: true, from: me, to: 'all', body: { kind: 'up' } })

      return () => {
        line.removeEventListener('message', onMessage)
        // Snapshot: drop() deletes from `serving` while we walk it.
        // oxlint-disable-next-line unicorn/no-useless-spread
        for (const them of [...serving.keys()]) drop(them)
        // A bus the hub opened, the hub closes.
        if (owned) (line as { close?(): void }).close?.()
      }
    },
  }
}

export function isHello(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { hello?: true }).hello === true
}

/** A watcher's side of a bus. Says hello, so the hub knows to serve it. */
export function channelOverBus(name: string, bus?: Bus, options: KeepAliveOptions = {}): Channel {
  const owned = bus === undefined
  const line = bus ?? openBus(name)
  const keepAlive = options.keepAlive ?? KEEP_ALIVE
  const timers = options.timers ?? wallClock
  const me = newName()
  const send = (body: unknown): void => {
    line.postMessage({ weft: true, from: me, to: 'graph', body })
  }
  send(HELLO)
  return {
    send,
    listen: handler => {
      const onMessage = (event: { data: unknown }): void => {
        const envelope = event.data
        if (!isEnvelope(envelope) || (envelope.to !== me && envelope.to !== 'all')) return
        handler(envelope.body)
      }
      line.addEventListener('message', onMessage)
      // The heartbeat lives with the listener: while somebody listens on this
      // end, the hub's lease on us is kept; stop listening and it runs out.
      const stopBeating = heartbeat(() => send(HELLO), keepAlive, timers)
      return () => {
        line.removeEventListener('message', onMessage)
        stopBeating()
      }
    },
    // A bus this channel opened, this channel closes.
    ...(owned
      ? {
          close: () => {
            ;(line as { close?(): void }).close?.()
          },
        }
      : {}),
  }
}
