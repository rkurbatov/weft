// Loom, the dialect: five words and nothing else. fact and view are the
// graph's own words under their dialect names; truth, will and laid are the
// doors and the laying, with the machinery under the floor.

export { input as fact, cell as view } from '#core/graph.ts'

// The dialect's own type words: a fact you can set, a view you can read.
// The graph's names stay in the engine room.
import type { Input, Watchable } from '#core/graph.ts'
export type Fact<T> = Input<T>
export type View<T> = Watchable<T>
export { truth, truthBy } from './truth.ts'
export type { Truth, TruthPassport } from './truth.ts'
export { will, sends, notes } from './will.ts'
export type { Will, WillDict, WillPassport, Refusal } from './will.ts'
export { laid } from './laid.ts'
export type { Board, Builder, Lane, LaidShape, LaidSpec } from './laid.ts'
export { together, firstOf } from '#core/remote.ts'

// The assembly word: the root wraps its domains in a region and owns their life.
export { region } from '#core/region.ts'

export { offer, adopt, carry } from './carry.ts'
export type { Offering, OfferOptions, Adopted, Carried, CarrySpec } from './carry.ts'
