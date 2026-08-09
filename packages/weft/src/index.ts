// The front door.
//
// Everything an application is written with, in one import — and nothing that
// only builds the library. The difference is the whole point of this file: a
// name is here because somebody writing a screen has a task it answers, not
// because it exists.
//
// What is deliberately not here: the classes behind cells, the engine and its
// probe, regions by name, the clock, structural sharing, the arithmetic of
// retries, the transports under the wire — broadcast lines, shared workers,
// hubs, envelopes, the leadership lock — the planner's vocabulary, and the
// constructors of an answer's states. Every one of them is reachable through
// the door of the package that owns it: `#graph`, `#wire`, `#store`, `#core`.
// Whoever builds a layer takes them there and knows what they are doing;
// whoever writes an application never has to meet them.
//
// The groups below are also doors of their own — `#weft/state`, `#weft/rows`
// and the rest — for anyone who would rather name what they are pulling in.
// The relational layer keeps its door at `#rel`: its words belong to the tree
// being built, not to the application.

export * from './groups/state.ts'
export * from './groups/rows.ts'
export * from './groups/line.ts'
export * from './groups/remote.ts'
export * from './groups/store.ts'
export * from './groups/outbox.ts'
export * from './groups/wire.ts'
