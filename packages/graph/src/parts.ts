// What the engine's parts promise each other.
//
// States, the mark by which a node is recognised across two copies of the
// library, and the two roles every node plays: something that can be read, and
// something that reads. Written here rather than inside the engine because
// nodes.ts implements them and engine.ts consumes them — a contract read from
// inside one side is a contract nobody reads.

/** Node states. CHECK means "an ancestor may have changed" — resolved by walking up. */
import type { Core } from './engine.ts'

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

export interface Node extends Marked {
  readonly engine: Core
  readonly name: string
  readonly observers: Set<Consumer>
  readonly demand: number
  /** Bring own value up to date. Port cells are always current. */
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
  readonly sources: Set<Node>
  readonly observers: Set<Consumer>
  /** 1 if links made by this consumer carry demand upward, 0 otherwise. */
  contribution(): number
  stabilize(): void
}

export interface RegionOf<T> {
  readonly name: string
  readonly value: T
  readonly disposed: boolean
  dispose(): void
}

export interface EngineOptions {
  /**
   * Where failures of this engine are reported. Without one, the first failure
   * of a round is thrown once the round has been carried to its end — loudly,
   * but never instead of waking the rest.
   */
  onError?: (error: unknown) => void
}
