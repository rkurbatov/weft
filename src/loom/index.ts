// Loom, the dialect: five words and nothing else. fact and view are the
// graph's own words under their dialect names; truth, will and laid are the
// doors and the laying, with the machinery under the floor.

export { input as fact, cell as view } from '../core/graph.ts'
export type { Input, Watchable, Readable } from '../core/graph.ts'
export { truth, truthBy } from './truth.ts'
export type { Truth, TruthPassport } from './truth.ts'
export { will, sends, notes } from './will.ts'
export type { Will, WillDict, WillPassport, Refusal } from './will.ts'
export { laid } from './laid.ts'
export type { Board, Builder, Lane, LaidShape, LaidSpec } from './laid.ts'
export { together, firstOf } from '../core/remote.ts'
