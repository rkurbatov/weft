// Addressing over a broadcast line.
//
// A broadcast carries everything to everybody, so a message says who it is
// from and who it is for, and each end keeps only what belongs to it. That is
// the whole of this file: envelopes, names, and the greeting by which a new
// arrival makes itself known.
//
// What is inside an envelope is none of its business — the protocol between a
// graph and a watcher lives in `channel.ts` and is carried, not read.

import type { Broadcast } from './transport.ts'

export const EVERYONE = 'all'
export const GRAPH = 'graph'

interface Envelope {
  readonly weft: true
  readonly from: string
  readonly to: string
  readonly body: unknown
}

function isEnvelope(message: unknown): message is Envelope {
  return typeof message === 'object' && message !== null && (message as Envelope).weft === true
}

/**
 * The version of what is said over the wire.
 *
 * Two tabs of one origin can be running different builds — one opened before
 * a deploy, one after — and they meet on the same bus. Without a version they
 * would talk past each other and fall apart somewhere far from the cause.
 * Raised whenever the shape of a message changes, never otherwise.
 */
export const PROTOCOL = 1

/** A greeting: how an arrival announces itself, its version, and whose it is. */
export function greeting(claim: string | undefined): unknown {
  return claim === undefined
    ? { hello: true, protocol: PROTOCOL }
    : { hello: true, protocol: PROTOCOL, claim }
}

/** The version an arrival speaks. Absent means a build from before versions. */
export function protocolOf(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const version = (body as { protocol?: unknown }).protocol
  return typeof version === 'number' ? version : undefined
}

export function isGreeting(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { hello?: true }).hello === true
}

export function claimOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const claim = (body as { claim?: unknown }).claim
  return typeof claim === 'string' ? claim : undefined
}

export function newName(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return (
    crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  )
}

export interface Postbox {
  readonly me: string
  send(to: string, body: unknown): void
  /** Everything addressed to us, or to everyone. */
  listen(handler: (from: string, body: unknown) => void): () => void
}

export function postbox(line: Broadcast, me: string): Postbox {
  return {
    me,
    send: (to, body) => line.post({ weft: true, from: me, to, body }),
    listen(handler) {
      return line.on(message => {
        if (!isEnvelope(message)) return
        // Our own letter, come back to us. A browser's bus never does this, an
        // in-memory line does, and a letter to everyone would otherwise be
        // answered by its own sender — endlessly.
        if (message.from === me) return
        if (message.to !== me && message.to !== EVERYONE) return
        handler(message.from, message.body)
      })
    },
  }
}
