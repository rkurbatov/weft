// Loom's words. fact and view are the graph's own under shorter names; truth,
// feed, will and laid are the doors and the picture, with the machinery under
// the floor.

export { input as fact, cell as view } from '#weft'

// The dialect's own type words: a fact you can set, a view you can read.
// The graph's names stay in the engine room.
import type { Input, Watchable } from '#weft'
export type Fact<T> = Input<T>
export type View<T> = Watchable<T>
export { truth, truthBy } from './truth.ts'
export type { Truth, TruthPassport } from './truth.ts'
export { feed } from './feed.ts'
export type { Feed, FeedPassport, Sorted, Delta } from './feed.ts'
export { will, sends, notes } from './will.ts'
export type { Will, WillDict, WillPassport, Refusal } from './will.ts'
export { laid } from './laid.ts'
export type { Board, Builder, Lane, LaidShape, LaidSpec } from './laid.ts'

// The assembly word: the root wraps its domains in a region and owns their life.
export { region } from '#weft'

export { offer, adopt, carry } from './carry.ts'
export type { Offering, OfferOptions, Adopted, Carried, CarrySpec } from './carry.ts'

export { byEach, fold, keyedBy, list, listsBy, shape } from './shape.ts'
export type { Group, ListSpec, ListView } from './shape.ts'
