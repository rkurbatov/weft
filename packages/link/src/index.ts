// The protocol: a graph on one side, a watcher on the other, and what passes
// between them.
//
// A station declares a surface — cells, tables, commands, lists — and a link
// hands back mirrors of it. Tables travel as differences, a follower that fell
// behind resyncs, a call that never came back is unknown rather than refused,
// and the work can be handed over to another tab mid-flight. What any of it
// travels on is `#wire`'s business, not this package's.

export { serve, listed } from './serve.ts'

export { link, Unknown } from './link.ts'

export { handedOver, handOver } from './handover.ts'
export type { HandedOver } from './handover.ts'

// The contract itself: what a station may offer, what a watcher gets back, and
// the vocabulary of the exchange. Said once, because three files implement
// halves of it.
export type {
  Link,
  LinkOptions,
  ListOffer,
  Mirrored,
  ServeOptions,
  Surface,
  ToGraph,
  ToWatcher,
} from './contract.ts'

// The same mirror, with the station's declaration kept as a type: a name that
// is not offered does not compile, and one that is arrives already typed.
export { faced } from './typed.ts'
export type { Faced } from './typed.ts'
