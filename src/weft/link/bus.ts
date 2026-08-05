// Tabs of one origin, talking over a broadcast line.
//
// This file is the protocol and nothing else: who is served and for how long,
// how an arrival is met, and how a watcher keeps itself known. The carrying is
// `transport.ts`, the addressing is `postbox.ts` — so the same protocol runs
// over a browser's bus, Node's own, or a pair of functions in a test.
//
// The graph's side is a hub rather than a channel: several tabs may be watching
// at once, and each of them gets a channel of its own.

import { wallClock } from '../core/graph/time.ts'
import type { Timers } from '../core/graph/time.ts'
import type { Channel } from './channel.ts'
import { claimOf, EVERYONE, GRAPH, greeting, isGreeting, newName, postbox } from './postbox.ts'
import { openBroadcast, overBus } from './transport.ts'
import type { Broadcast, BusLike } from './transport.ts'

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
  /**
   * Who may be served. A tab says whose it is when it greets the hub; a hub
   * holding one person's household refuses anybody else's — by name, so the tab
   * learns why it sees nothing instead of watching an empty screen. Without
   * this everyone is admitted, which is right for an application with one graph
   * and one person.
   */
  admit?: (claim: string | undefined) => boolean
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

/** Where a bus comes from: a line given, a BroadcastChannel-shaped thing, or a name. */
function lineFor(name: string, given?: Broadcast | BusLike): { line: Broadcast; owned: boolean } {
  if (given === undefined) return { line: openBroadcast(name), owned: true }
  return { line: 'post' in given ? given : overBus(given), owned: false }
}

/** The graph's side of a bus: a hub that hands out one channel per watcher. */
export function busHub(name: string, bus?: Broadcast | BusLike, options: HubOptions = {}): Hub {
  const { line, owned } = lineFor(name, bus)
  const mail = postbox(line, GRAPH)
  const lease = options.lease ?? LEASE
  const timers = options.timers ?? wallClock
  const admit = options.admit

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

      const stopListening = mail.listen((them, body) => {
        if (!serving.has(them) && admit !== undefined && !admit(claimOf(body))) {
          // Somebody else's tab. Say so and serve nothing: a replica handed to
          // the wrong session is a leak, and silence would look like a fault.
          mail.send(them, { kind: 'refused', why: `not this station's session` })
          return
        }

        if (!serving.has(them)) {
          // A tab we have not met — or one whose lease ran out and who is back:
          // give it a channel of its own. Its serve announces itself, so a
          // returning watcher re-asks for everything on its own accord.
          const channel: Channel = {
            send: body_ => mail.send(them, body_),
            listen: handler => {
              handlers.set(them, handler)
              return () => handlers.delete(them)
            },
          }
          serving.set(them, { stop: onWatcher(channel) })
        }
        renew(them)
        if (body !== undefined && !isGreeting(body)) handlers.get(them)?.(body)
      })

      // Say we are here to the whole bus at once: watchers that outlived the
      // last graph re-ask immediately instead of waiting out their heartbeat,
      // and their watches introduce them before any command of theirs flies.
      mail.send(EVERYONE, { kind: 'up' })

      return () => {
        stopListening()
        // A copy on purpose: drop() deletes from `serving` while we walk it.
        const leaving = Array.from(serving.keys())
        for (const them of leaving) drop(them)
        // A bus the hub opened, the hub closes.
        if (owned) line.close()
      }
    },
  }
}

/** A watcher's side of a bus. Greets the hub, so it knows to serve it. */
export interface ChannelOptions extends KeepAliveOptions {
  /** Whose tab this is. The hub of a station serving one person checks it. */
  claim?: string
}

export function busChannel(
  name: string,
  bus?: Broadcast | BusLike,
  options: ChannelOptions = {},
): Channel {
  const { line, owned } = lineFor(name, bus)
  const mail = postbox(line, newName())
  const keepAlive = options.keepAlive ?? KEEP_ALIVE
  const timers = options.timers ?? wallClock
  const hello = greeting(options.claim)

  const say = (body: unknown): void => mail.send(GRAPH, body)
  say(hello)

  return {
    send: say,
    listen(handler) {
      const stopListening = mail.listen((_from, body) => handler(body))
      // The heartbeat lives with the listener: while somebody listens on this
      // end, the hub's lease on us is kept; stop listening and it runs out.
      const stopBeating = heartbeat(() => say(hello), keepAlive, timers)
      return () => {
        stopListening()
        stopBeating()
      }
    },
    // A bus this channel opened, this channel closes.
    ...(owned ? { close: () => line.close() } : {}),
  }
}
