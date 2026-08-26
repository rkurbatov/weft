// Derived graph: port cells (one writer each), derived cells (formulas),
// watchers. Dependencies are discovered by reading, never declared.
//
// Demand is counted alongside the links: a source knows whether any live
// watcher depends on it, which is how adapters learn when to start and stop.
//
// Every node belongs to an engine from birth and carries it in a field, so
// reading, watching and tracing never have to be told which graph is meant.
// The propagation core itself lives in engine.ts.

import { Core, coreForBuild, markOf, register } from './engine.ts'
import type { Consumer, EngineOptions, RegionOf as Region, State } from './engine.ts'
import { CHECK, CLEAN } from './engine.ts'
import type { Probe } from './ticks.ts'
import {
  Derived as DerivedCell,
  engineOf,
  Port as PortCell,
  Watcher as WatcherNode,
} from './nodes.ts'
import type { Derived, Port } from './nodes.ts'
import type { DerivedOptions, PortOptions, Watchable, WatchOptions } from './nodes.ts'
import { OBSERVED } from './parts.ts'
import type { Keeper, Node } from './parts.ts'

// What a node is lives next door; passed through here so that one import of
// this file gives an application everything it needs.
export { Derived, Port, Watcher, engineOf } from './nodes.ts'
export type {
  DerivedOptions,
  Equal,
  PortOptions,
  Readable,
  Watchable,
  WatchOptions,
} from './nodes.ts'

function buildPort<T>(core: Core, initial: T, options?: PortOptions<T>): Port<T> {
  return new PortCell(initial, options, core)
}

function buildDerived<T>(core: Core, formula: () => T, options?: DerivedOptions<T>): Derived<T> {
  const c = new DerivedCell(formula, options, core)
  core.owned(() => c.dispose())
  return c
}

function buildWatcher(core: Core, body: () => void, options?: WatchOptions): () => void {
  const w = new WatcherNode(body, options, core)
  core.owned(() => w.dispose())
  return () => w.dispose()
}

export function port<T>(initial: T, options?: PortOptions<T>): Port<T> {
  return buildPort(coreForBuild(), initial, options)
}

export function derived<T>(formula: () => T, options?: DerivedOptions<T>): Derived<T> {
  return buildDerived(coreForBuild(), formula, options)
}

export function watch(body: () => void, options?: WatchOptions): () => void {
  return buildWatcher(coreForBuild(), body, options)
}

/** Group writes so watchers see one settled picture. */
export function batch<T>(fn: () => T): T {
  return coreForBuild().batch(fn)
}

/** Read without becoming dependent on it. */
export function untracked<T>(fn: () => T): T {
  return coreForBuild().untracked(fn)
}

/** Watch one cell; the listener sees only actual changes. */
export function subscribe<T>(
  source: Watchable<T>,
  listener: (value: T) => void,
  options?: WatchOptions,
): () => void {
  // The node knows its engine, so subscribing never has to be told.
  const core = engineOf(source) ?? coreForBuild()
  let first = true
  return buildWatcher(
    core,
    () => {
      const value = source.get()
      if (first) {
        first = false
        return
      }
      core.untracked(() => listener(value))
    },
    options,
  )
}

// ── Looking at the graph ─────────────────────────────────────────────────────

export interface Trace {
  name: string
  kind: 'input' | 'cell'
  /** 'port' for inputs; for cells, the truth about how current `value` is. */
  state: 'port' | 'clean' | 'check' | 'dirty' | 'failed'
  value: unknown
  reads?: Trace[]
  readBy: string[]
}

function watcherName(consumer: Consumer): string {
  const kind = markOf(consumer)
  if (kind === 'cell') return consumer.name
  if (kind === 'watcher') return '(watcher)'
  return '(node)'
}

/**
 * A look at a node without touching it: its held value as-is — possibly stale,
 * the state says so — what it reads, who reads it. Nothing recomputes on
 * account of being looked at; that is the whole point of a debugger.
 */
export function trace(node: Watchable<unknown>, depth = 2): Trace {
  const kind = markOf(node)
  if (kind === 'input') {
    const held = node as unknown as Port<unknown>
    return {
      name: held.name,
      kind: 'input',
      state: 'port',
      value: held.peek(),
      readBy: [...held.observers].map(watcherName),
    }
  }
  if (kind === 'cell') {
    const cellNode = node as unknown as Derived<unknown>
    const raw = node as unknown as { value?: unknown; state: State; failure: unknown }
    const reads =
      depth > 0
        ? [...cellNode.sources].flatMap(s =>
            markOf(s) === 'input' || markOf(s) === 'cell'
              ? [trace(s as unknown as Watchable<unknown>, depth - 1)]
              : [],
          )
        : undefined
    return {
      name: cellNode.name,
      kind: 'cell',
      state: cellNode.broken
        ? 'failed'
        : raw.state === CLEAN
          ? 'clean'
          : raw.state === CHECK
            ? 'check'
            : 'dirty',
      value: raw.value,
      ...(reads === undefined ? {} : { reads }),
      readBy: [...cellNode.observers].map(watcherName),
    }
  }
  return { name: '(unknown)', kind: 'cell', state: 'dirty', value: undefined, readBy: [] }
}

/** Attach a probe. With no engine given, the one a bare build would use. */
export function attachProbe(probe: Probe | null, engine?: Engine): void {
  ;(engine === undefined ? coreForBuild() : engine.core).tap.attach(probe)
}

// ── The engine ───────────────────────────────────────────────────────────────

/**
 * An engine owned as a value: its own propagation, its own regions, its own
 * probe, its own end of life. Nodes born in it carry it; nothing here is
 * shared with a neighbouring engine except the platform underneath.
 */
export interface Engine {
  readonly name: string
  /** The propagation core. Library plumbing reaches for it; applications do not. */
  readonly core: Core
  readonly disposed: boolean
  port<T>(initial: T, options?: PortOptions<T>): Port<T>
  derived<T>(formula: () => T, options?: DerivedOptions<T>): Derived<T>
  watch(body: () => void, options?: WatchOptions): () => void
  batch<T>(fn: () => T): T
  untracked<T>(fn: () => T): T
  /** Build with this engine as the ambient one — for modules that use the bare functions. */
  build<T>(fn: () => T): T
  region<T>(name: string, build: () => T): Region<T>
  /**
   * Read something from another engine here. The only door between engines:
   * readable, never writable, declared at build time and visible in a trace.
   * Demand crosses with it — the shared engine works only while somebody looks.
   */
  adopt<T>(source: Watchable<T>): Watchable<T>
  attachProbe(probe: Probe | null): void
  dispose(): void
}

export function graph(name = 'engine', how?: EngineOptions): Engine {
  const core = new Core(name, how)
  register(core)
  const engine: Engine = {
    name,
    core,
    get disposed() {
      return core.disposed
    },
    port: (initial, options) => buildPort(core, initial, options),
    derived: (formula, options) => buildDerived(core, formula, options),
    watch: (body, options) => buildWatcher(core, body, options),
    batch: fn => core.batch(fn),
    untracked: fn => core.untracked(fn),
    build: fn => core.build(fn),
    region: (regionName, build) => core.region(regionName, build),
    adopt: source => adopt(core, source),
    attachProbe: probe => core.tap.attach(probe),
    dispose: () => core.dispose(),
  }
  return engine
}

function adopt<T>(core: Core, source: Watchable<T>): Watchable<T> {
  const home = engineOf(source)
  if (home === undefined) throw new Error('weft: only a node of another engine can be adopted')
  if (home === core) return source
  const named = source as unknown as { name: string }
  let hot: (() => void) | undefined
  const mirror = buildPort(core, source.peek(), {
    name: `adopted(${named.name})`,
    // Demand crosses the border but is not what keeps the value true: the
    // shared engine starts its own sources only while somebody here looks.
    onDemand: () => {
      hot = buildWatcher(home, () => {
        source.get()
      })
    },
    onIdle: () => {
      hot?.()
      hot = undefined
    },
  })
  // A cold watcher, always: it carries the value across without asking the
  // shared engine to work, so an unwatched formula here is as fresh as it
  // would be reading an ordinary cell.
  const cold = buildWatcher(
    home,
    () => {
      const value = source.get()
      core.untracked(() => mirror.set(value))
    },
    { demand: false },
  )
  core.owned(() => {
    hot?.()
    cold()
  })
  // Readable, never writable: a session cannot rewrite common truth.
  return {
    get: () => mirror.get(),
    peek: () => mirror.peek(),
  }
}

/**
 * Package-internal: whoever holds a node asks to hear when it stops being read
 * and starts again. Passing `undefined` takes the ear away, which every cache
 * owes a node it has let go of — an old handle a caller kept must not go on
 * reporting to an owner it no longer belongs to.
 *
 * A function rather than the bare slot, so the symbol stays inside the graph
 * and the two caches that need this — the cell family and the query cache —
 * speak the same one sentence. Named in `#graph`, never in `#weft`: this is
 * the retention contract between the graph and whoever keeps its nodes, not a
 * second set of lifecycle hooks for applications.
 */
export function keep(node: unknown, keeper: Keeper | undefined): void {
  ;(node as Node)[OBSERVED] = keeper
}
