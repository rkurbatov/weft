// The engine: one propagation core, owned as a value.
//
// Everything a graph needs while it works — who is reading, what is being
// tracked, how deep the batch is, which watchers are queued — lives here
// rather than in module variables. One isolate can therefore hold several
// graphs that do not share a queue, a batch, or a lifetime.
//
// This matters in two places, and both are ours. A leading tab or a shared
// worker serves tabs belonging to different people: their data must not meet.
// And a widget embedded in someone else's page has no "the" graph at all —
// each application builds its own.
//
// Nodes carry their core from birth, so reading, watching and tracing never
// ask which engine is meant. Reading across engines is refused by name: a
// stitch between two people's data is not something to discover later.

import { WaveTap } from './waves.ts'

/** Node states. CHECK means "an ancestor may have changed" — resolved by walking up. */
export const CLEAN = 0
export const CHECK = 1
export const DIRTY = 2

export type State = typeof CLEAN | typeof CHECK | typeof DIRTY

/**
 * Nodes are recognised by mark, not by class. A page may end up with two
 * copies of this library — two bundles, a host page and a widget — and
 * `instanceof` across copies is false. The symbol is registered globally, so
 * both copies agree on it.
 */
export const NODE = Symbol.for('weft.node')

export type NodeKind = 'input' | 'cell' | 'watcher'

export interface Marked {
  readonly [NODE]: NodeKind
}

export function markOf(value: unknown): NodeKind | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const kind = (value as Partial<Marked>)[NODE]
  return kind === 'input' || kind === 'cell' || kind === 'watcher' ? kind : undefined
}

export interface Source extends Marked {
  readonly engine: Core
  readonly name: string
  readonly observers: Set<Consumer>
  readonly demand: number
  /** Bring own value up to date. Stored cells are always current. */
  stabilize(): void
  /** Called by the graph when the number of demanding paths changes. */
  demandChanged(delta: number): void
}

export interface Consumer extends Marked {
  readonly engine: Core
  readonly name: string
  /** Leaf of the graph. A plain field: the hot path asks this on every mark. */
  readonly leaf: boolean
  state: State
  readonly sources: Set<Source>
  readonly observers: Set<Consumer>
  /** 1 if links made by this consumer carry demand upward, 0 otherwise. */
  contribution(): number
  stabilize(): void
}

/** Anything the engine takes down when it goes: watchers, and regions' teardowns. */
interface Mortal {
  dispose(): void
}

export interface RegionOf<T> {
  readonly name: string
  readonly value: T
  readonly disposed: boolean
  dispose(): void
}

interface Owner {
  name: string
  teardowns: Array<() => void>
}

export interface EngineOptions {
  /**
   * Where failures of this engine are reported. Without one, the first failure
   * of a round is thrown once the round has been carried to its end — loudly,
   * but never instead of waking the rest.
   */
  onError?: (error: unknown) => void
}

/**
 * How many times one watcher may wake within a single settling before it is
 * called a loop. Generous: a watcher legitimately woken again by another's
 * write is ordinary, a hundred of them is not.
 */
const ROUNDS_BEFORE_SUSPICION = 100

export class Core {
  readonly name: string
  private readonly onError: ((error: unknown) => void) | undefined
  private batchDepth = 0
  private workDepth = 0
  private readonly pending = new Set<Consumer>()
  /** Whether a settling is already running: writes from watchers join it. */
  private settling = false
  private readonly notices: Array<() => void> = []
  /**
   * Watchers, and only watchers: they are the leaves that hold demand, and
   * there are as many of them as there are screens — not as many as there are
   * rows. Cells are left to garbage collection; without a watcher they are
   * inert anyway.
   */
  private readonly watchers = new Set<Mortal>()
  private held: Owner | null = null
  private readonly household: Array<() => void> = []
  private dead = false

  constructor(name: string, options: EngineOptions = {}) {
    this.name = name
    this.onError = options.onError
  }

  get disposed(): boolean {
    return this.dead
  }

  // ── Building ───────────────────────────────────────────────────────────────

  /** Run a build with this core as the ambient one. Synchronous by contract. */
  build<T>(fn: () => T): T {
    return buildIn(this, fn)
  }

  /**
   * Give the enclosing region something to let go of. No region — nobody holds
   * it: a table keeps a cell per row, and remembering a teardown for each would
   * be a leak with the engine as its cause. What the engine takes down by
   * itself is watchers (registered separately) and the regions it holds.
   */
  owned(teardown: () => void): void {
    this.held?.teardowns.push(teardown)
  }

  /** The name prefix of the enclosing region, if any. */
  regionName(): string | undefined {
    return this.held?.name
  }

  enterRegion(name: string): Owner {
    const owner: Owner = {
      name: this.held === null ? name : `${this.held.name}.${name}`,
      teardowns: [],
    }
    this.held = owner
    return owner
  }

  leaveRegion(previous: Owner | null): void {
    this.held = previous
  }

  currentRegion(): Owner | null {
    return this.held
  }

  /**
   * A region owns a piece of this engine: everything created while it builds is
   * remembered and let go in one move, in reverse order of birth. Regions nest,
   * and names nest with them.
   */
  region<T>(name: string, build: () => T): RegionOf<T> {
    const before = this.held
    const owner = this.enterRegion(name)
    let value: T
    try {
      value = this.build(build)
    } finally {
      this.leaveRegion(before)
    }
    let dead = false
    // Whoever holds this region: the engine itself, or the region around it.
    const holder = before === null ? this.household : before.teardowns
    const kill = (): void => {
      if (dead) return
      dead = true
      for (let i = owner.teardowns.length - 1; i >= 0; i--) owner.teardowns[i]?.()
      owner.teardowns.length = 0
      // And sign itself out of the holder's list. Without this, a long-lived
      // region that raises and drops modules — a modal, a route, a panel —
      // keeps a dead closure for every one of them, forever.
      const at = holder.indexOf(kill)
      if (at >= 0) holder.splice(at, 1)
    }
    holder.push(kill)
    return {
      name: owner.name,
      value,
      get disposed() {
        return dead
      },
      dispose: kill,
    }
  }

  keepWatcher(watcher: Mortal): void {
    this.watchers.add(watcher)
  }

  forgetWatcher(watcher: Mortal): void {
    this.watchers.delete(watcher)
  }

  // ── Work ───────────────────────────────────────────────────────────────────

  /**
   * Source lifecycle hooks run after the graph is quiet, never inside a
   * formula: an adapter is free to write its own cell from them.
   */
  notice(fn: () => void): void {
    this.notices.push(fn)
    if (this.workDepth === 0) this.drain()
  }

  private drain(): void {
    while (this.notices.length > 0) {
      const fn = this.notices.shift()
      if (fn !== undefined) fn()
    }
  }

  enter(): void {
    this.workDepth++
  }

  leave(): void {
    this.workDepth--
    if (this.workDepth === 0) {
      this.tap.close()
      this.drain()
    }
  }

  /** Direct source changed: consumer must recompute. */
  markDirty(node: Consumer): void {
    if (node.leaf) {
      // Always queue: a watcher marked while it runs must still be woken.
      node.state = DIRTY
      this.pending.add(node)
      return
    }
    if (node.state === DIRTY) return
    node.state = DIRTY
    for (const o of node.observers) this.markCheck(o)
  }

  /** Something upstream changed: consumer must verify before trusting its value. */
  markCheck(node: Consumer): void {
    if (node.leaf) {
      if (node.state === CLEAN) node.state = CHECK
      this.pending.add(node)
      return
    }
    if (node.state !== CLEAN) return
    node.state = CHECK
    for (const o of node.observers) this.markCheck(o)
  }

  /** Resolve CHECK by stabilizing sources; a changed source flips us to DIRTY. */
  verify(node: Consumer): boolean {
    for (const s of node.sources) {
      s.stabilize()
      if (node.state === DIRTY) return true
    }
    return false
  }

  detach(node: Consumer, sources: Iterable<Source>): void {
    const carried = node.contribution()
    for (const s of sources) {
      s.observers.delete(node)
      if (carried > 0) s.demandChanged(-carried)
    }
  }

  unlink(node: Consumer): void {
    this.detach(node, node.sources)
    node.sources.clear()
  }

  unqueue(node: Consumer): void {
    this.pending.delete(node)
  }

  /** Run a formula or a watcher body, keeping links that it reads again. */
  retrack(node: Consumer, body: () => void): void {
    const prevActive = active
    const prevTracking = tracking
    const previous = new Set(node.sources)
    node.sources.clear()
    active = node
    tracking = previous
    try {
      body()
    } finally {
      active = prevActive
      tracking = prevTracking
      // Whatever was not read again is no longer a dependency.
      this.detach(node, previous)
    }
  }

  flush(): void {
    if (this.batchDepth > 0) return
    // A write from inside a watcher's body used to start a settling of its
    // own, on top of the one already running: a loop then blew the call stack
    // before anything could be counted or named. A write during a settling
    // only queues; the settling already under way takes it.
    if (this.settling) return
    this.settling = true
    this.enter()
    const failures: unknown[] = []
    try {
      // Watchers may write, queueing more watchers; drain until quiet.
      //
      // A loop — a watcher writing what it reads — used to spin a thousand
      // rounds of the whole graph before saying anything, which on a heavy
      // graph is seconds of a frozen tab and a message naming nobody. Counting
      // per node instead finds the culprit in the round where it misbehaves,
      // and names it.
      let woken: Map<Consumer, number> | undefined
      while (this.pending.size > 0) {
        const round = Array.from(this.pending)
        this.pending.clear()
        if (round.length > 0) {
          woken ??= new Map()
          for (const w of round) {
            const times = (woken.get(w) ?? 0) + 1
            woken.set(w, times)
            if (times > ROUNDS_BEFORE_SUSPICION) {
              throw new Error(
                `weft: "${w.name}" in engine "${this.name}" has woken ${times} times in one ` +
                  `settling — something in this round writes what it reads, directly or ` +
                  `through another watcher`,
              )
            }
          }
        }
        // One watcher failing is not a reason for its neighbours to sleep
        // through the change: the round is carried to its end, and what fell
        // is collected on the way.
        for (const w of round) {
          try {
            w.stabilize()
          } catch (error) {
            failures.push(error)
          }
        }
      }
    } finally {
      this.settling = false
      this.leave()
      this.report(failures)
    }
  }

  /** A failure the engine has to answer for: reported, or thrown — never swallowed. */
  report(failures: readonly unknown[]): void {
    if (failures.length === 0) return
    if (this.onError === undefined) throw failures[0]
    for (const error of failures) this.onError(error)
  }

  /** Group writes so watchers see one settled picture. */
  batch<T>(fn: () => T): T {
    this.batchDepth++
    this.enter()
    try {
      return fn()
    } finally {
      this.batchDepth--
      try {
        this.flush()
      } finally {
        this.leave()
      }
    }
  }

  /** Read without becoming dependent on it. */
  untracked<T>(fn: () => T): T {
    return untracked(fn)
  }

  /** The probe of this engine: waves of one session are not mixed with another's. */
  readonly tap = new WaveTap()

  // ── End of life ────────────────────────────────────────────────────────────

  dispose(): void {
    if (this.dead) return
    this.dead = true
    // Watchers first: their going gives demand back, and adapters learn to stop.
    // A copy on purpose: each dispose removes itself from the set, and
    // iterating the live set would skip half of them.
    const leaving = Array.from(this.watchers)
    for (const w of leaving) w.dispose()
    this.watchers.clear()
    for (let i = this.household.length - 1; i >= 0; i--) this.household[i]?.()
    this.household.length = 0
    this.pending.clear()
    this.notices.length = 0
    this.tap.detach()
    forget(this)
  }
}

/**
 * Who is reading right now is a property of the call stack, not of an engine:
 * a formula of one engine can reach for a node of another, and that reach is
 * exactly what has to be refused. So the reader is tracked per isolate, and
 * the engines are compared at the moment of the link.
 */
let active: Consumer | null = null
let tracking: Set<Source> | null = null

export function track(source: Source): void {
  const consumer = active
  if (consumer === null) return
  if (source.engine !== consumer.engine) throw crossing(consumer, source)
  if (consumer.sources.has(source)) return
  consumer.sources.add(source)
  // A link that survives a recompute keeps its observer slot and its demand.
  if (tracking !== null && tracking.delete(source)) return
  source.observers.add(consumer)
  const carried = consumer.contribution()
  if (carried > 0) source.demandChanged(carried)
}

/** Read without becoming dependent on it. */
export function untracked<T>(fn: () => T): T {
  const prevActive = active
  const prevTracking = tracking
  active = null
  tracking = null
  try {
    return fn()
  } finally {
    active = prevActive
    tracking = prevTracking
  }
}

function crossing(reader: Consumer, source: Source): Error {
  return new Error(
    `weft: "${reader.name}" in engine "${reader.engine.name}" read "${source.name}", ` +
      `which lives in engine "${source.engine.name}". Engines do not read each other; ` +
      `publish from a shared engine and adopt it instead.`,
  )
}

// ── The registry ─────────────────────────────────────────────────────────────

let building: Core | null = null
let root: Core | null = null
const registered = new Set<Core>()

function buildIn<T>(core: Core, fn: () => T): T {
  const before = building
  building = core
  try {
    return fn()
  } finally {
    building = before
  }
}

export function register(core: Core): void {
  registered.add(core)
}

function forget(core: Core): void {
  registered.delete(core)
}

/** Engines alive right now — for a tools panel, and for the ambiguity rule. */
export function engines(): readonly Core[] {
  return [...registered]
}

/**
 * Which core a bare `input`/`cell`/`watch` belongs to.
 *
 * With no engine registered there is nothing to be ambiguous about: the root
 * core serves, and an ordinary single-graph application never learns that
 * engines exist. The moment one is registered, building without saying where
 * means one user's cell landing in another user's graph — so it is refused.
 * A build that crossed an `await` lands here too, which is the point.
 */
export function coreForBuild(): Core {
  if (building !== null) return building
  if (registered.size > 0) {
    const names = [...registered].map(c => `"${c.name}"`).join(', ')
    throw new Error(
      `weft: cannot build without an engine while ${names} ${registered.size === 1 ? 'is' : 'are'} alive. ` +
        `Use engine.input/cell/watch, or build inside engine.build(...).`,
    )
  }
  root ??= new Core('root')
  return root
}

/** The core in charge of a build right now, if any. */
export function buildingCore(): Core | null {
  return building
}
