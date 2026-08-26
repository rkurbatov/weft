// The three kinds of node, and nothing else.
//
// A port holds what came from outside and is the only thing written to. A
// derived cell is a formula and recomputes when what it read moves. A watcher
// is a leaf: it runs, and runs again when what it read moves.
//
// Building them — in which engine, owned by which region — is the business of
// graph.ts next door; here is only what they are.

import { CHECK, CLEAN, coreForBuild, DIRTY, markOf, NODE, observe, WATCHED } from './engine.ts'
import type { Core } from './engine.ts'
import type { Consumer, NodeKind, Node, State } from './engine.ts'

export type Equal<T> = (a: T, b: T) => boolean

/**
 * Whether two failures are the same failure. The same object is; otherwise it
 * is the name and the sentence, walking down the cause, since a formula that
 * throws on every run makes a fresh Error each time and a reader must not be
 * woken sixty times a second for one unchanging complaint. Stacks are not
 * compared: they say where it was thrown, not what went wrong.
 */
function sameFailure(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!(a instanceof Error) || !(b instanceof Error)) return false
  return a.name === b.name && a.message === b.message && sameFailure(a.cause, b.cause)
}

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
export class Port<T> implements Node {
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
    observe(this)
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
/**
 * Package-private: the one way to drop a cell somebody else is holding for a
 * cache. Not exported from the package — see `[RELEASE]` below for why it is a
 * question and not two.
 */
export const RELEASE: unique symbol = Symbol('weft.release')

/** Package-private: how a cache installs its listener. See `[WATCHING]` below. */
export const WATCHING: unique symbol = Symbol('weft.watching')

export class Derived<T> implements Node, Consumer {
  get [NODE](): NodeKind {
    return 'cell'
  }

  get leaf(): boolean {
    return false
  }
  readonly engine: Core
  state: State = DIRTY
  readonly sources = new Set<Node>()
  readonly observers = new Set<Consumer>()
  readonly name: string
  demand = 0
  private value!: T
  private valued = false
  private running = false
  // A cache's listener, if one asked. A plain field and two methods on the
  // prototype: a field under a symbol name is built per instance, and that
  // showed up as three times the cost of admitting a member.
  private watching: ((watched: boolean) => void) | undefined = undefined
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
    observe(this)
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

  /** Package-private: a cache asks to hear when this cell is read and unread. */
  [WATCHING](listener: ((watched: boolean) => void) | undefined): void {
    this.watching = listener
  }

  /** The engine, at the two moments the observer set fills and goes empty. */
  [WATCHED](watched: boolean): void {
    this.watching?.(watched)
  }

  /**
   * Package-private: let go of this cell if nothing is using it, and say
   * whether it went. A cache asks this instead of testing and disposing in two
   * steps — the two could disagree, and did: `dispose` refuses a cell whose
   * formula is on the stack, so a cache that tested only for watchers killed
   * the very run that was building the member it went on to hand back.
   */
  [RELEASE](): boolean {
    if (this.running || this.observers.size > 0) return false
    this.dispose()
    return true
  }

  /** Let go of the sources. Next read recomputes from scratch. */
  dispose(): void {
    if (this.running) throw new Error(`weft: cannot dispose cell "${this.name}" while it computes`)
    this.engine.unlink(this)
    this.state = DIRTY
    this.valued = false
    this.failure = null
  }

  stabilize(): void {
    if (this.state === CLEAN) return
    if (this.running) throw new Error(`weft: cycle through cell "${this.name}"`)
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
      this.running = true
      try {
        core.retrack(this, () => {
          next = this.formula()
        })
      } catch (error) {
        // The links read before the throw stay: they are the way back. When one
        // of them moves, the formula runs again and may well succeed.
        thrown = { error }
      } finally {
        this.running = false
      }
      if (thrown !== null) {
        const was = this.failure
        this.failure = thrown
        this.state = CLEAN
        core.tap.fail(this.name, thrown.error)
        // Breaking is a change like any other: whoever reads this must hear it.
        // And so is breaking DIFFERENTLY — "cannot divide by zero" giving way
        // to "no such column" is a new state, not the same one twice. Gating on
        // "was it broken already" left the reader holding the older reason for
        // good, since nothing else would ever wake it.
        if (was === null || !sameFailure(was.error, thrown.error))
          for (const o of this.observers) core.markDirty(o)
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
      // Node hooks queued during the run fire here — value in place, state settled.
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
  readonly sources = new Set<Node>()
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
