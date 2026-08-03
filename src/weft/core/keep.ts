// Persistence. Only stored cells are kept — a formula is recomputed, never
// restored. What is kept carries the moment it arrived, so an answer that
// survives a reload is honest about its age instead of pretending to be new.
//
// The disk is asynchronous, and two things follow. Restoring never delays the
// first show: the screen starts on the initial value, and what the disk held
// arrives as an ordinary write — unless a human or the network got there first,
// because what was done while the disk was thinking is newer than what it
// holds. And a refusal to write is a declared state, not a silence: `saving`
// says whether writes are landing, and why not.

import { input, subscribe } from './graph.ts'
import type { Input, Watchable } from './graph.ts'
import { heldOf } from './remote.ts'
import type { Source } from './source.ts'
import type { Store } from './store.ts'

/** Why something on disk was not put back. */
export type Dropped = 'version' | 'age' | 'unreadable'

/** Whether what happens here is reaching the store. */
export type Saving = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export const SAVING: Saving = { ok: true }

interface Envelope {
  v: number
  at: number
  value: unknown
}

export interface KeepOptions<T> {
  key: string
  store: Store
  /** Bump it when the shape changes; anything written under another version is dropped or migrated. */
  version?: number
  /** Anything older than this is not put back. */
  maxAge?: number
  now?: () => number
  /** Rescue what an older version wrote. Return undefined to drop it. */
  migrate?: (stored: unknown, from: number) => T | undefined
  onDropped?: (why: Dropped, key: string) => void
}

export interface Kept {
  /** Resolves once the disk has been asked: true if something was put back. */
  readonly restored: Promise<boolean>
  /** Are writes landing. `ok: false` names the reason they are not. */
  readonly saving: Watchable<Saving>
  /** Stop keeping it; what is on disk stays. */
  stop(): void
  /** Stop keeping it and wipe what is on disk. */
  forget(): void
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * One writer per kept key. Changes coalesce while a write is in flight — the
 * queue is never lost, and the disk always ends on the latest value. A refusal
 * turns `saving` off with a reason; the next change simply tries again, so a store
 * that comes back (quota freed, private mode left) is picked up by itself.
 */
function pumpFor(options: { key: string; store: Store; version?: number }) {
  const { key, store, version = 1 } = options
  const saving = input<Saving>(SAVING, { name: `${key}.saving` })
  let pending: Envelope | undefined
  let flying = false

  const drain = (): void => {
    if (flying || pending === undefined) return
    const load = pending
    pending = undefined
    flying = true
    store.write(key, load).then(
      () => {
        flying = false
        saving.set(SAVING)
        drain()
      },
      (error: unknown) => {
        flying = false
        saving.set({ ok: false, reason: describe(error) })
        // A newer value may be waiting; it gets its try — one per change, so a
        // dead disk costs one refusal per edit, not a loop.
        drain()
      },
    )
  }

  return {
    saving,
    push: (value: unknown, at: number): void => {
      pending = { v: version, at, value }
      drain()
    },
  }
}

async function readEnvelope<T>(
  options: KeepOptions<T>,
  saving: Input<Saving>,
): Promise<{ value: unknown; at: number } | undefined> {
  const { key, store, version = 1, maxAge, migrate, onDropped } = options
  const now = options.now ?? Date.now

  let raw: unknown
  try {
    raw = await store.read(key)
  } catch (error) {
    // The disk did not answer. Nothing to put back — and writes are not likely
    // to land either, which is the same declared state.
    saving.set({ ok: false, reason: describe(error) })
    return undefined
  }
  if (raw === undefined || raw === null) return undefined

  const envelope = raw as Envelope
  if (
    typeof envelope !== 'object' ||
    typeof envelope.v !== 'number' ||
    typeof envelope.at !== 'number'
  ) {
    onDropped?.('unreadable', key)
    void store.remove(key).catch(() => {})
    return undefined
  }

  let value = envelope.value
  if (envelope.v !== version) {
    const rescued = migrate?.(envelope.value, envelope.v)
    if (rescued === undefined) {
      onDropped?.('version', key)
      void store.remove(key).catch(() => {})
      return undefined
    }
    value = rescued
  }

  if (maxAge !== undefined && now() - envelope.at >= maxAge) {
    onDropped?.('age', key)
    void store.remove(key).catch(() => {})
    return undefined
  }

  return { value, at: envelope.at }
}

/**
 * Keep a stored cell. Watching is cold: persistence records what happens
 * anyway and never asks for work of its own.
 */
export function keepInput<T>(target: Input<T>, options: KeepOptions<T>): Kept {
  const now = options.now ?? Date.now
  const writes = pumpFor(options)
  let touched = false
  let restoring = false

  const stop = subscribe(
    target,
    value => {
      if (restoring) return
      touched = true
      writes.push(value, now())
    },
    { demand: false },
  )

  const restored = readEnvelope(options, writes.saving).then(found => {
    // A human got there while the disk was thinking; theirs is newer.
    if (found === undefined || touched) return false
    restoring = true
    try {
      target.set(found.value as T)
    } finally {
      restoring = false
    }
    return true
  })

  return {
    restored,
    saving: writes.saving,
    stop,
    forget: () => {
      stop()
      void options.store.remove(options.key).catch(() => {})
    },
  }
}

/**
 * Keep what a source last held. The moment of arrival is kept with it, so after
 * a reload the value is as old as it really is: within shelf life it is served
 * as it stands, past it the first demand asks again.
 */
export function keepSource<T>(feed: Source<T>, options: KeepOptions<T>): Kept {
  const writes = pumpFor(options)
  let restoring = false

  const stop = subscribe(
    feed.state,
    state => {
      if (restoring) return
      const held = heldOf(state)
      // Nothing held yet, and a refusal never overwrites a good answer.
      if (held === undefined) return
      writes.push(held.value, held.at)
    },
    { demand: false },
  )

  const restored = readEnvelope(options, writes.saving).then(found => {
    if (found === undefined) return false
    // The network answered while the disk was thinking; the answer is newer.
    if (heldOf(feed.state.peek()) !== undefined) return false
    restoring = true
    try {
      feed.restore(found.value as T, found.at)
    } finally {
      restoring = false
    }
    return true
  })

  return {
    restored,
    saving: writes.saving,
    stop,
    forget: () => {
      stop()
      void options.store.remove(options.key).catch(() => {})
    },
  }
}
