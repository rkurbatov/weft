// Cell graph: stored cells (one writer each), derived cells (formulas),
// watchers. Dependencies are discovered by reading, never declared.
//
// Demand is counted alongside the links: a source knows whether any live
// watcher depends on it, which is how adapters learn when to start and stop.
//
// Every node belongs to an engine from birth and carries it in a field, so
// reading, watching and tracing never have to be told which graph is meant.
// The propagation core itself lives in engine.ts.

import { CHECK, CLEAN, Core, coreForBuild, declare, DIRTY, markOf, NODE, track } from './engine.ts'
import type {
  Consumer,
  EngineOptions,
  NodeKind,
  RegionOf as Region,
  Source,
  State,
} from './engine.ts'
import type { Probe } from './waves.ts'

export type Equal<T> = (a: T, b: T) => boolean

export interface CellOptions<T> {
  equal?: Equal<T>
  name?: string
}

export interface InputOptions<T> extends CellOptions<T> {
  /** First live watcher arrived. Runs outside any formula. */
  onDemand?: () => void
  /** Last live watcher left. Runs outside any formula. */
  onIdle?: () => void
}

/** Stored cell: the only thing that can be written, by its single writer. */
export class Input<T> implements Source {
  // Mark and shape live on the prototype, not on every node: a table can hold
  // a cell per row, and three extra slots per node are three too many.
  get [NODE](): NodeKind {
    return 'input'
  }
  readonly engine: Core
  readonly observers = new Set<Consumer>()
  readonly name: string
  demand = 0
  private current: T
  private readonly equal: Equal<T>
  private readonly onDemand: (() => void) | undefined
  private readonly onIdle: (() => void) | undefined

  constructor(initial: T, options: InputOptions<T> = {}, core: Core = coreForBuild()) {
    this.engine = core
    this.current = initial
    this.equal = options.equal ?? Object.is
    const prefix = core.regionName()
    const bare = options.name ?? 'input'
    this.name = prefix === undefined ? bare : `${prefix}.${bare}`
    this.onDemand = options.onDemand
    this.onIdle = options.onIdle
  }

  stabilize(): void {}

  demandChanged(delta: number): void {
    const before = this.demand
    this.demand += delta
    if (before === 0 && this.demand > 0 && this.onDemand !== undefined)
      this.engine.notice(this.onDemand)
    else if (before > 0 && this.demand === 0 && this.onIdle !== undefined)
      this.engine.notice(this.onIdle)
  }

  /** Somebody live depends on this cell right now. */
  get demanded(): boolean {
    return this.demand > 0
  }

  get(): T {
    track(this)
    return this.current
  }

  peek(): T {
    return this.current
  }

  set(next: T): void {
    if (this.equal(this.current, next)) return
    this.current = next
    const core = this.engine
    core.enter()
    try {
      if (core.tap.watching) core.tap.write(this.name, next)
      for (const o of this.observers) core.markDirty(o)
      core.flush()
    } finally {
      core.leave()
    }
  }

  update(fn: (prev: T) => T): void {
    this.set(fn(this.current))
  }
}

/** Derived cell: a formula. Nobody writes it; it recomputes when its inputs move. */
export class Cell<T> implements Source, Consumer {
  get [NODE](): NodeKind {
    return 'cell'
  }

  get leaf(): boolean {
    return false
  }
  readonly engine: Core
  state: State = DIRTY
  readonly sources = new Set<Source>()
  readonly observers = new Set<Consumer>()
  readonly name: string
  demand = 0
  private value!: T
  private valued = false
  private computing = false
  /**
   * What the formula threw last time, if it did. Held rather than rethrown from
   * a fresh run: a formula that fails on every read would otherwise fail once
   * per reader, side effects and all.
   */
  private failure: { error: unknown } | null = null
  private readonly formula: () => T
  private readonly equal: Equal<T>

  constructor(formula: () => T, options: CellOptions<T> = {}, core: Core = coreForBuild()) {
    this.engine = core
    this.formula = formula
    this.equal = options.equal ?? Object.is
    const prefix = core.regionName()
    const bare = options.name ?? 'cell'
    this.name = prefix === undefined ? bare : `${prefix}.${bare}`
  }

  contribution(): number {
    return this.demand > 0 ? 1 : 0
  }

  demandChanged(delta: number): void {
    const before = this.demand
    this.demand += delta
    if (before === 0 && this.demand > 0) {
      for (const s of this.sources) s.demandChanged(1)
    } else if (before > 0 && this.demand === 0) {
      for (const s of this.sources) s.demandChanged(-1)
    }
  }

  get(): T {
    track(this)
    this.stabilize()
    if (this.failure !== null) throw this.failure.error
    return this.value
  }

  peek(): T {
    return this.engine.untracked(() => this.get())
  }

  /** The formula threw and the cell has not recovered. Its links are still live. */
  get broken(): boolean {
    return this.failure !== null
  }

  /** Somebody downstream is reading this cell right now. */
  get observed(): boolean {
    return this.observers.size > 0
  }

  /** Somebody live depends on this cell right now. */
  get demanded(): boolean {
    return this.demand > 0
  }

  /** Let go of the sources. Next read recomputes from scratch. */
  dispose(): void {
    if (this.computing)
      throw new Error(`weft: cannot dispose cell "${this.name}" while it computes`)
    this.engine.unlink(this)
    this.state = DIRTY
    this.valued = false
    this.failure = null
  }

  stabilize(): void {
    if (this.state === CLEAN) return
    if (this.computing) throw new Error(`weft: cycle through cell "${this.name}"`)
    if (this.state === CHECK && !this.engine.verify(this)) {
      this.state = CLEAN
      return
    }
    this.recompute()
  }

  private recompute(): void {
    const core = this.engine
    core.enter()
    try {
      const started = core.tap.watching ? core.tap.now() : 0
      let next!: T
      let thrown: { error: unknown } | null = null
      this.computing = true
      try {
        core.retrack(this, () => {
          next = this.formula()
        })
      } catch (error) {
        // The links read before the throw stay: they are the way back. When one
        // of them moves, the formula runs again and may well succeed.
        thrown = { error }
      } finally {
        this.computing = false
      }
      if (thrown !== null) {
        const wasBroken = this.failure !== null
        this.failure = thrown
        this.state = CLEAN
        core.tap.fail(this.name, thrown.error)
        // Breaking is a change like any other: whoever reads this must hear it.
        if (!wasBroken) for (const o of this.observers) core.markDirty(o)
        return
      }
      // A first value is not a change: nobody held a previous one from us.
      const hadValue = this.valued && this.failure === null
      const changed = hadValue && !this.equal(this.value, next)
      const recovered = this.failure !== null
      this.failure = null
      this.value = next
      this.valued = true
      this.state = CLEAN
      if (core.tap.watching)
        core.tap.compute(this.name, core.tap.now() - started, changed, hadValue)
      // Equal result stops here: observers stay CHECK and settle without recomputing.
      if (changed || recovered) for (const o of this.observers) core.markDirty(o)
    } finally {
      // Source hooks queued during the run fire here — value in place, state settled.
      core.leave()
    }
  }
}

/** Watcher: leaf of the graph. Runs its body, then reruns it when what it read moves. */
export interface WatchOptions {
  /**
   * Whether watching counts as asking. A cold watcher (`demand: false`) sees the
   * changes that happen anyway but causes no work of its own — that is what
   * persistence and logging want.
   */
  demand?: boolean
}

export class Watcher implements Consumer {
  get [NODE](): NodeKind {
    return 'watcher'
  }

  get leaf(): boolean {
    return true
  }
  readonly engine: Core
  readonly name = '(watcher)'
  state: State = DIRTY
  readonly sources = new Set<Source>()
  readonly observers = new Set<Consumer>()
  private disposed = false
  private readonly body: () => void
  private readonly demanding: boolean

  constructor(body: () => void, options: WatchOptions = {}, core: Core = coreForBuild()) {
    this.engine = core
    this.body = body
    this.demanding = options.demand ?? true
    core.keepWatcher(this)
    this.run()
  }

  contribution(): number {
    return this.disposed || !this.demanding ? 0 : 1
  }

  stabilize(): void {
    if (this.disposed || this.state === CLEAN) return
    if (this.state === CHECK && !this.engine.verify(this)) {
      this.state = CLEAN
      return
    }
    this.run()
  }

  private run(): void {
    const core = this.engine
    core.enter()
    try {
      if (core.tap.watching) core.tap.wake()
      core.retrack(this, this.body)
    } catch (error) {
      // Named in the wave, then rethrown: the round that woke us decides what
      // to do with it — carry on and report, rather than stop here.
      core.tap.fail(this.name, error)
      throw error
    } finally {
      this.state = CLEAN
      core.leave()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.engine.enter()
    try {
      this.engine.unlink(this) // still contributing, so demand is given back before we go
      this.disposed = true
      this.engine.unqueue(this)
      this.engine.forgetWatcher(this)
    } finally {
      this.engine.leave()
    }
  }
}

export type Readable<T> = Input<T> | Cell<T>

/**
 * Anything that can be read and watched. Stated structurally so that a mirror,
 * a view, or anything else with a value can stand where a cell stands.
 */
export interface Watchable<T> {
  get(): T
  peek(): T
}

/** The engine a node was born in, when the thing at hand is a node at all. */
export function engineOf(value: unknown): Core | undefined {
  return markOf(value) === undefined ? undefined : (value as { engine: Core }).engine
}

// ── Building in an engine ────────────────────────────────────────────────────

function makeInput<T>(core: Core, initial: T, options?: InputOptions<T>): Input<T> {
  return new Input(initial, options, core)
}

function makeCell<T>(core: Core, formula: () => T, options?: CellOptions<T>): Cell<T> {
  const c = new Cell(formula, options, core)
  core.owned(() => c.dispose())
  return c
}

function makeWatcher(core: Core, body: () => void, options?: WatchOptions): () => void {
  const w = new Watcher(body, options, core)
  core.owned(() => w.dispose())
  return () => w.dispose()
}

export function input<T>(initial: T, options?: InputOptions<T>): Input<T> {
  return makeInput(coreForBuild(), initial, options)
}

export function cell<T>(formula: () => T, options?: CellOptions<T>): Cell<T> {
  return makeCell(coreForBuild(), formula, options)
}

export function watch(body: () => void, options?: WatchOptions): () => void {
  return makeWatcher(coreForBuild(), body, options)
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
  return makeWatcher(
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
  /** 'stored' for inputs; for cells, the truth about how current `value` is. */
  state: 'stored' | 'clean' | 'check' | 'dirty' | 'failed'
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
    const held = node as unknown as Input<unknown>
    return {
      name: held.name,
      kind: 'input',
      state: 'stored',
      value: held.peek(),
      readBy: [...held.observers].map(watcherName),
    }
  }
  if (kind === 'cell') {
    const derived = node as unknown as Cell<unknown>
    const raw = node as unknown as { value?: unknown; state: State; failure: unknown }
    const reads =
      depth > 0
        ? [...derived.sources].flatMap(s =>
            markOf(s) === 'input' || markOf(s) === 'cell'
              ? [trace(s as unknown as Watchable<unknown>, depth - 1)]
              : [],
          )
        : undefined
    return {
      name: derived.name,
      kind: 'cell',
      state: derived.broken
        ? 'failed'
        : raw.state === CLEAN
          ? 'clean'
          : raw.state === CHECK
            ? 'check'
            : 'dirty',
      value: raw.value,
      ...(reads === undefined ? {} : { reads }),
      readBy: [...derived.observers].map(watcherName),
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
  input<T>(initial: T, options?: InputOptions<T>): Input<T>
  cell<T>(formula: () => T, options?: CellOptions<T>): Cell<T>
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
  declare(core)
  const engine: Engine = {
    name,
    core,
    get disposed() {
      return core.disposed
    },
    input: (initial, options) => makeInput(core, initial, options),
    cell: (formula, options) => makeCell(core, formula, options),
    watch: (body, options) => makeWatcher(core, body, options),
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
  const mirror = makeInput(core, source.peek(), {
    name: `adopted(${named.name})`,
    // Demand crosses the border but is not what keeps the value true: the
    // shared engine starts its own sources only while somebody here looks.
    onDemand: () => {
      hot = makeWatcher(home, () => {
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
  const cold = makeWatcher(
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
