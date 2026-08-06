// Loom's words. One word for a cell — which kind it is decided by what it is
// given, and the word is the language's own; truth, feed, will and laid are the doors and the picture, with
// the machinery under the floor.

export { cell } from './cell.ts'
export type { Cell } from './cell.ts'
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

export { shape } from './shape.ts'
export type { Part } from './shape.ts'
export { byEach, fold } from './group.ts'
export type { Group } from './group.ts'
export { keyedBy } from './keys.ts'
export { list, listsBy } from './list.ts'
export type { ListSpec, ListView } from './list.ts'
export { Timeout, when, whenever } from './wait.ts'
export type { Standing, WheneverOptions, WhenOptions, WhileRunning } from './wait.ts'
