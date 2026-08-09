// The protocol: a graph on one side, a watcher on the other, and what passes
// between them.
//
// A station declares a surface — cells, tables, commands, lists — and a link
// hands back mirrors of it. Tables travel as differences, a follower that fell
// behind resyncs, a call that never came back is unknown rather than refused,
// and the work can be handed over to another tab mid-flight. What any of it
// travels on is `#wire`'s business, not this package's.

export { serve, listed } from './serve.ts'
export type { Surface, ServeOptions, ListOffer } from './serve.ts'
export { link, Unknown } from './link.ts'
export type { Link, LinkOptions, Mirrored } from './link.ts'
export { handedOver, handOver } from './handover.ts'
export type { HandedOver } from './handover.ts'
