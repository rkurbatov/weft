// The carrier's converter. A domain's face crosses the wire in dialect terms:
// the station offers its views, facts and acts; a tab adopts them and gets the
// same face back — views read plain (the mirror's Remote is unwrapped here,
// under the floor), facts write through, acts return promises. The book, the
// laying and the truths live in the station only; a tab holds nothing but
// mirrors.

import { derived, port } from '#weft'
import { preserve } from '#core'
import type { Watchable } from '#weft'
import { heldOf } from '#weft'
import { gauge } from '#weft'
import { quietly } from '#graph'
import type { TickSummary } from '#weft'
import { serve } from '#weft'
import type { ServeOptions } from '#weft'
import { link } from '#weft'
import type { LinkOptions } from '#weft'
import type { Channel } from '#weft'
import type { ListOffer, Mirrored } from '#weft'
import type { Lock } from '#wire'
import { subscribe } from '#weft'

export interface Offering {
  views?: Readonly<Record<string, Watchable<unknown>>>
  /**
   * What the other side may write into.
   *
   * The least a thing must be to be written into, not `Port<never>`: a port of
   * strings is not a port of nevers, and asking for one made every station in
   * the world cast its own ports. Found by writing a station.
   */
  facts?: Readonly<Record<string, { set(value: never): void }>>
  acts?: Readonly<Record<string, (...args: never[]) => unknown>>
  /**
   * Lists that travel as differences: what entered and what left, not the
   * whole list every time.
   *
   * For a window onto something big. Scrolling by one row sends one row.
   */
  // Built with `listed()`: the least a list must be, not `never[]`, so a
  // station keeps its own row type and never casts.
  lists?: Readonly<Record<string, ListOffer>>
  /**
   * Tables followed whole: a snapshot, then batches of what changed.
   *
   * For a table a panel shows all of — a corpus being filled and edited while
   * it is watched. A window onto something bigger is a `list` instead, and the
   * difference is real: a table travels with its own change log, a list with
   * the order it is to be shown in.
   */
  tables?: Readonly<Record<string, { readonly name: string }>>
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
    const tail = port<readonly TickSummary[]>([], { name: 'loom.waves' })
    const book = gauge({ keep, onTick: () => quietly(() => tail.set([...book.log.ticks()])) })
    book.start()
    stopInstruments = () => book.stop()
    cells['loom.waves'] = tail
  }

  const stop = serve(
    {
      cells,
      ...(handles.facts === undefined ? {} : { facts: handles.facts }),
      ...(handles.lists === undefined ? {} : { lists: handles.lists }),
      ...(handles.tables === undefined ? {} : { tables: handles.tables }),
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
  /**
   * A list the station publishes as differences: rows here, kept up to date by
   * what entered and what left.
   *
   * For a window onto something big — scrolling by one row costs one row.
   */
  list<R>(name: string): Mirrored<R>
  /**
   * A table the station publishes whole: a snapshot, then what changed.
   *
   * Read the same way as a list; what differs is what crosses and how a lost
   * batch is made up for.
   */
  table<R>(name: string): Mirrored<R>
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

  // Names are declared by the station, so this map is as big as the face and no
  // bigger; the mirrors under it are let go on their own when nobody looks.
  const list = <R>(name: string): Mirrored<R> => wire.table<R>(name)
  const followed = <R>(name: string): Mirrored<R> => wire.table<R>(name)

  const view = <T>(name: string): Watchable<T | undefined> => {
    const known = faces.get(name)
    if (known !== undefined) return known as Watchable<T | undefined>
    const mirror = wire.derived<T>(name)
    // The unwrapping lives here, under the floor: a screen reads plain — and
    // an unchanged piece keeps being the very same object across flushes.
    let previous: T | undefined
    const face = derived(
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
    list,
    table: followed,
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

import { busChannel, busHub } from '#wire'
import { leadOrFollow, webLocks } from '#wire'
import { wirePair } from '#weft'

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
    const pair = wirePair()
    const stopServe = built.serve(pair.graph)
    const role = port<'inline' | 'leading' | 'following'>('inline', { name: `${spec.name}.role` })
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

  const role = port<'inline' | 'leading' | 'following'>('following', {
    name: `${spec.name}.role`,
  })
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
  const channel = busChannel(spec.name)
  return {
    channel,
    role,
    stop: () => {
      stopLead()
      channel.close?.()
    },
  }
}
