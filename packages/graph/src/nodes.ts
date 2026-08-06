// The three kinds of node, and nothing else.
//
// A port holds what came from outside and is the only thing written to. A
// derived cell is a formula and recomputes when what it read moves. A watcher
// is a leaf: it runs, and runs again when what it read moves.
//
// Building them — in which engine, owned by which region — is the business of
// graph.ts next door; here is only what they are.

import { CHECK, CLEAN, Core, coreForBuild, DIRTY, markOf, NODE, track } from './engine.ts'
import type { Consumer, NodeKind, Source, State } from './engine.ts'

export type Equal<T> = (a: T, b: T) => boolean

export interface DerivedOptions<T> {
  equal?: Equal<T>
  name?: string
}

export interface PortOptions<T> extends DerivedOptions<T> {
  /** First live watcher arrived. Runs outside any formula. */
  onDemand?: () => void
  /** Last live watcher left. Runs outside any formula. */
  onIdle?: () => void
}

/** Port cell: the only thing that can be written, by its single writer. */
export class Port<T> implements Source {
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

  constructor(initial: T, options: PortOptions<T> = {}, core: Core = coreForBuild()) {
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
export class Derived<T> implements Source, Consumer {
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

  constructor(formula: () => T, options: DerivedOptions<T> = {}, core: Core = coreForBuild()) {
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

export type Readable<T> = Port<T> | Derived<T>

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
