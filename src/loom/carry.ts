// The carrier's converter. A domain's face crosses the wire in dialect terms:
// the station offers its views, facts and acts; a tab adopts them and gets the
// same face back — views read plain (the mirror's Remote is unwrapped here,
// under the floor), facts write through, acts return promises. The book, the
// laying and the truths live in the station only; a tab holds nothing but
// mirrors.

import { cell, input } from '#weft'
import type { Input, Watchable } from '#weft'
import { heldOf } from '#weft'
import { preserve } from '#weft'
import { journal } from '#weft'
import { quietly } from '#weft'
import type { WaveSummary } from '#weft'
import { serve } from '#weft'
import type { ServeOptions } from '#weft'
import { link } from '#weft'
import type { LinkOptions } from '#weft'
import type { Channel } from '#weft'
import type { Lock } from '#weft'
import { subscribe } from '#weft'

export interface Offering {
  views?: Readonly<Record<string, Watchable<unknown>>>
  facts?: Readonly<Record<string, Input<never>>>
  acts?: Readonly<Record<string, (...args: never[]) => unknown>>
}

export interface OfferOptions extends ServeOptions {
  /** Publish the station's waves as a view, for instruments on the other side. */
  instruments?: boolean | { keep?: number }
}

/** The station's side: put a face on the wire. */
export function offer(handles: Offering, channel: Channel, options: OfferOptions = {}): () => void {
  const cells: Record<string, Watchable<unknown>> = { ...handles.views }
  let stopInstruments: (() => void) | undefined

  if (options.instruments !== undefined && options.instruments !== false) {
    const keep = options.instruments === true ? 64 : (options.instruments.keep ?? 64)
    const tail = input<readonly WaveSummary[]>([], { name: 'loom.waves' })
    const book = journal(keep, () => quietly(() => tail.set([...book.waves()])))
    book.start()
    stopInstruments = () => book.stop()
    cells['loom.waves'] = tail
  }

  const stop = serve(
    {
      cells,
      ...(handles.facts === undefined
        ? {}
        : { facts: handles.facts as Readonly<Record<string, { set(value: never): void }>> }),
      ...(handles.acts === undefined ? {} : { commands: handles.acts }),
    },
    channel,
    options,
  )
  return () => {
    stop()
    stopInstruments?.()
  }
}

export interface Adopted {
  /** The station's views, read plain: undefined until the first value lands. */
  view<T>(name: string): Watchable<T | undefined>
  /** The station's facts: write-through. */
  write(fact: string, value: unknown): void
  /** The station's acts. */
  act<A extends readonly unknown[], T = void>(name: string): (...args: A) => Promise<T>
  /** Hold demand on the named views (what a mounted screen would do). */
  warm(names: readonly string[]): () => void
  close(): void
}

/** The tab's side: take a face off the wire. */
export function adopt(channel: Channel, options: LinkOptions = {}): Adopted {
  const wire = link(channel, options)
  const faces = new Map<string, Watchable<unknown>>()

  const view = <T>(name: string): Watchable<T | undefined> => {
    const known = faces.get(name)
    if (known !== undefined) return known as Watchable<T | undefined>
    const mirror = wire.cell<T>(name)
    // The unwrapping lives here, under the floor: a screen reads plain — and
    // an unchanged piece keeps being the very same object across flushes.
    let previous: T | undefined
    const face = cell(
      () => {
        const held = heldOf(mirror.get())
        if (held === undefined) return undefined
        const kept = previous === undefined ? held.value : preserve(previous, held.value)
        previous = kept
        return kept
      },
      { name: `adopted.${name}` },
    )
    faces.set(name, face)
    return face
  }

  return {
    view,
    write: (fact, value) => wire.write(fact, value),
    act: name => wire.command(name),
    warm(names) {
      const stops = names.map(name => subscribe(view(name), () => {}))
      return () => {
        for (const stop of stops) stop()
      }
    },
    close: () => wire.close(),
  }
}

// ── The carrier's choice ────────────────────────────────────────────────────
// Where the station lives is a deployment mode, not an architecture: with tabs
// able to talk and to elect (BroadcastChannel + web locks), one of them leads
// and serves the rest; without them the station lives right here, inline.
// A SharedWorker carrier stays an explicit two-entry wiring for now.

import { busHub, channelOverBus } from '#weft'
import { leadOrFollow, webLocks } from '#weft'
import { pairInMemory } from '#weft'

export interface Carried {
  /** This side's channel to whoever carries the station. */
  channel: Channel
  role: Watchable<'inline' | 'leading' | 'following'>
  stop(): void
}

export interface CarrySpec {
  name: string
  /** Build the station; called only where it comes to live. */
  station: () => { serve: (channel: Channel) => () => void; dispose?: () => void }
}

export interface CarryOptions {
  /** The deployment mode. 'auto' sniffs the platform; tests state it plainly —
   *  platforms grow capabilities, and a sniff is not a contract. */
  mode?: 'auto' | 'inline' | 'tabs'
  /** The lock to elect with; tests hand in their own. */
  lock?: Lock
}

export function carry(spec: CarrySpec, options: CarryOptions = {}): Carried {
  const mode = options.mode ?? 'auto'
  const tabsCanTalk =
    mode === 'tabs' ||
    (mode === 'auto' &&
      typeof BroadcastChannel !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      'locks' in navigator)

  if (!tabsCanTalk) {
    const built = spec.station()
    const pair = pairInMemory()
    const stopServe = built.serve(pair.graph)
    const role = input<'inline' | 'leading' | 'following'>('inline', { name: `${spec.name}.role` })
    return {
      channel: pair.watcher,
      role,
      stop: () => {
        stopServe()
        built.dispose?.()
        pair.watcher.close?.()
        pair.graph.close?.()
      },
    }
  }

  const role = input<'inline' | 'leading' | 'following'>('following', { name: `${spec.name}.role` })
  const stopLead = leadOrFollow({
    name: spec.name,
    lock: options.lock ?? webLocks(),
    lead: () => {
      role.set('leading')
      // The hub — and its bus — are opened by the leader only: a follower
      // holds nothing it would have to let go of.
      const hub = busHub(spec.name)
      const built = spec.station()
      const stopHub = hub.accept(channel => built.serve(channel))
      return () => {
        stopHub()
        built.dispose?.()
      }
    },
    follow: () => {
      role.set('following')
      return () => {}
    },
  })

  // The channel carry opened, carry closes: whoever adopted it may have
  // closed it already, and a second close is a shrug, not a fault.
  const channel = channelOverBus(spec.name)
  return {
    channel,
    role,
    stop: () => {
      stopLead()
      channel.close?.()
    },
  }
}
