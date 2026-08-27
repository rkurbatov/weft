// The three kinds of node, and nothing else.
//
// A port holds what came from outside and is the only thing written to. A
// derived cell is a formula and recomputes when what it read moves. A watcher
// is a leaf: it runs, and runs again when what it read moves.
//
// Building them — in which engine, owned by which region — is the business of
// graph.ts next door; here is only what they are.

import { CHECK, CLEAN, coreForBuild, DIRTY, markOf, NODE, observe } from './engine.ts'
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

  /** Somebody is a reader of this port, whether or not they ask it to work. */
  get observed(): boolean {
    return this.observers.size > 0
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

  /**
   * Let go of the sources. Next read recomputes from scratch.
   *
   * A turn of the graph like any other, because it changes the graph: without
   * the enter and leave the engine believed itself quiet in the middle of
   * unlinking, and a lifecycle hook that had asked to run once the dust
   * settled ran instead between two links coming off.
   */
  dispose(): void {
    if (this.running) throw new Error(`weft: cannot dispose cell "${this.name}" while it computes`)
    const core = this.engine
    core.enter()
    try {
      core.unlink(this)
      this.state = DIRTY
      this.valued = false
      this.failure = null
    } finally {
      core.leave()
    }
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

/**
 * A cell that owns its links only while somebody is actually reading it.
 *
 * An ordinary cell keeps the sources it found until it is disposed, which is
 * right for a cell an application holds and wrong for a bridge inside the
 * library: one read of `face.flight.peek()` left the face an observer of the
 * source for ever, and a cache that retains by being read would then never let
 * a single key go. The lifecycle belongs to the edge of ownership, not to the
 * object that happens to own four of them — so each bridge lets go by itself,
 * and "is this face in use" is the union of real graph edges rather than a
 * counter somebody has to keep.
 *
 * The contract differs from `derived` in one visible way: a facet caches
 * nothing for a reader who does not stay. A tracked read behaves exactly as
 * before; a bare `get()` or `peek()` computes, answers, and hands the sources
 * back before returning, so the next such read computes again. That is the
 * price of the bridge not outliving its use, and these are projections of one
 * cell, not work worth keeping.
 *
 * Package-private on purpose: for an application this is not a second kind of
 * formula, it is the machinery behind a door.
 */
export class Facet<T> extends Derived<T> {
  /**
   * Two states, not one, because a deferred thing that can be called off has
   * two: whether letting go is still the right answer, and whether something
   * is already standing in the queue to ask. Folding them into one flag let a
   * reader that came and went a hundred thousand times inside one turn queue a
   * hundred thousand callbacks — one release happened, which is why it looked
   * right, and the queue carried the rest of them for nothing.
   */
  private releaseWanted = false
  private releaseQueued = false

  private releaseNow(): void {
    // Calls off the intention as well: a reader that came back must not be let
    // go of at all, and a bare read that let go first leaves nothing to redo.
    this.releaseWanted = false
    this[RELEASE]()
  }

  override get(): T {
    try {
      return super.get()
    } finally {
      // The same question the caches ask, asked by the cell about itself:
      // read by somebody or on the stack, it stays; otherwise it hands the
      // sources back. One predicate for all of its users.
      this.releaseNow()
    }
  }

  override peek(): T {
    // Straight to the base `get`, not through this class's own: `Derived.peek`
    // calls `get` virtually, so going the ordinary way asked one read the
    // release question twice.
    try {
      return this.engine.untracked(() => super.get())
    } finally {
      this.releaseNow()
    }
  }

  observationChanged(observed: boolean): void {
    this.releaseWanted = !observed
    if (observed || this.releaseQueued) return
    // Not here and now: this runs inside the engine's unlinking. Within one
    // turn a facet can lose its last reader, gain one, and lose it again; the
    // callback already standing there is reused, and what it finds when it
    // runs is the answer that counts.
    this.releaseQueued = true
    this.engine.notice(() => {
      this.releaseQueued = false
      if (!this.releaseWanted) return
      this.releaseNow()
    })
  }
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
