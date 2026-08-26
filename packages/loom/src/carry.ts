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
import type { Station } from './assemble.ts'
import { underOwner } from './owner.ts'
import type { Owner } from './owner.ts'

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

/** Can this be read as well as written? Then it need not be declared twice. */
const readable = (thing: unknown): thing is Watchable<unknown> =>
  typeof (thing as Watchable<unknown>)?.get === 'function' &&
  typeof (thing as Watchable<unknown>)?.peek === 'function'

/** The station's side: put a face on the wire. */
export function offer(handles: Offering, channel: Channel, options: OfferOptions = {}): () => void {
  const cells: Record<string, Watchable<unknown>> = { ...handles.views }
  // A port is one thing, and a station had to name it twice — once under
  // `views` to be read, once under `facts` to be written — with the two halves
  // free to drift apart under one name. A fact that can be read is published
  // as itself; a station that says otherwise in `views` still wins.
  for (const [name, fact] of Object.entries(handles.facts ?? {})) {
    if (cells[name] === undefined && readable(fact)) cells[name] = fact
  }
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

/** What a view of the offering holds, seen from the other side. */
type Held<C> = C extends Watchable<infer T> ? T : never

/** What a fact takes, seen from the other side. */
type Written<F> = F extends { set(value: infer V): void } ? V : never

/** What a list or table carries, row by row. */
type Rows<T> = T extends { all: Watchable<readonly (infer R)[]> }
  ? R
  : T extends { rows: Watchable<readonly (infer R)[]> }
    ? R
    : unknown

/**
 * The station's own face, with its names and types intact.
 *
 * The names and types are known at the moment the station is declared, and
 * were thrown away one line later: a screen asked for `view<number>('seats')`
 * — a string the compiler cannot check and a type stated a second time by
 * hand. Rename a view on the station and every screen went on compiling and
 * started reading undefined. Nothing crosses the wire differently; this only
 * remembers what was declared.
 */
export interface Face<O extends Offering> {
  readonly views: {
    readonly [K in keyof O['views']]: Watchable<Held<O['views'][K]> | undefined>
  } & { readonly [K in keyof O['facts']]: Watchable<Written<O['facts'][K]> | undefined> }
  readonly facts: { readonly [K in keyof O['facts']]: (value: Written<O['facts'][K]>) => void }
  readonly acts: {
    readonly [K in keyof O['acts']]: O['acts'][K] extends (...args: infer A) => infer T
      ? (...args: A) => Promise<Awaited<T>>
      : never
  }
  readonly lists: { readonly [K in keyof O['lists']]: Mirrored<Rows<O['lists'][K]>> }
  readonly tables: { readonly [K in keyof O['tables']]: Mirrored<Rows<O['tables'][K]>> }
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

/**
 * A door onto named things, kept.
 *
 * The same name gives back the same thing: a screen putting `app.face.acts.add`
 * in a dependency list or comparing it against a previous render must not be
 * handed a new function every time it looks. Symbols pass through untouched —
 * `then` is asked for by name, but a promise-check asks by symbol, and a proxy
 * that answers everything makes itself look like a thenable.
 */
function door<T extends object>(make: (name: string) => unknown): T {
  const kept = new Map<string, unknown>()
  return new Proxy({} as T, {
    get: (target, name) => {
      if (typeof name !== 'string') return Reflect.get(target, name)
      const standing = kept.get(name)
      if (standing !== undefined || kept.has(name)) return standing
      const made = make(name)
      kept.set(name, made)
      return made
    },
    has: () => true,
  })
}

/** The typed face over an adopted station: names checked, values already shaped. */
export function facing<O extends Offering>(taken: Adopted): Face<O> {
  return {
    views: door<Face<O>['views']>(name => taken.view(name)),
    facts: door<Face<O>['facts']>(name => (value: unknown) => taken.write(name, value)),
    acts: door<Face<O>['acts']>(name => taken.act(name)),
    lists: door<Face<O>['lists']>(name => taken.list(name)),
    tables: door<Face<O>['tables']>(name => taken.table(name)),
  }
}

/** What a station offers, read off the station's own type. For a worker panel,
 *  where there is no station on this side to infer it from. */
export type OfferingOf<S> = S extends Station<infer O> ? O : never

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
  /**
   * Whose station this is.
   *
   * Not only where a durable book is kept — where the station itself is. Tabs
   * elect one of themselves to do the work and mirror it to the rest, and they
   * elect by a name: two tabs of one application under different sessions
   * shared that name, so one of them led and the other received its whole
   * screen. The book was already apart by then, which made the leak quieter,
   * not smaller: every view, fact and act crossed.
   *
   * So an owner partitions the election and the bus as well as the shelf, and
   * the claim on the wire says whose tab is asking. Sessions do not compete
   * for one lock and do not refuse each other; they simply hold separate
   * elections and raise stations of their own.
   */
  owner?: Owner
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

/**
 * The word tabs elect and talk by. One per owner, so sessions never meet.
 *
 * Joined with a slash and not with a NUL, though NUL is what the rest of the
 * library separates parts with: a broadcast channel's name crosses into the
 * platform, and there it is a C string — two names differing only after a NUL
 * are one channel, so two sessions kept meeting on a bus they had every reason
 * to think was their own. A slash is safe because a session and an application
 * may not contain one; `within` refuses such a name for the same reason.
 */
function partOf(spec: CarrySpec): string {
  if (spec.owner === undefined) return spec.name
  return `${spec.name}/${spec.owner.app}/${spec.owner.session}`
}

export function carry(spec: CarrySpec, options: CarryOptions = {}): Carried {
  const mode = options.mode ?? 'auto'
  const part = partOf(spec)
  const claim = spec.owner === undefined ? undefined : `${spec.owner.app}/${spec.owner.session}`
  // Whatever this station builds is built under its owner — the shelf included.
  // Stated here rather than by the caller, so a station raised by a lock grant
  // minutes later is raised under the same owner as one raised at once.
  const build = (): { serve: (channel: Channel) => () => void; dispose?: () => void } =>
    spec.owner === undefined ? spec.station() : underOwner(spec.owner, spec.station)
  const tabsCanTalk =
    mode === 'tabs' ||
    (mode === 'auto' &&
      typeof BroadcastChannel !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      'locks' in navigator)

  if (!tabsCanTalk) {
    const built = build()
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
    name: part,
    lock: options.lock ?? webLocks(),
    lead: () => {
      role.set('leading')
      // The hub — and its bus — are opened by the leader only: a follower
      // holds nothing it would have to let go of.
      // Belt as well as braces: separate elections keep sessions apart, and a
      // tab that reaches the wrong bus anyway is turned away by name rather
      // than handed a replica of somebody else's screen.
      const hub = busHub(
        part,
        undefined,
        claim === undefined ? {} : { admit: (asked: string | undefined) => asked === claim },
      )
      const built = build()
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
  const channel = busChannel(part, undefined, claim === undefined ? {} : { claim })
  return {
    channel,
    role,
    stop: () => {
      stopLead()
      channel.close?.()
    },
  }
}
