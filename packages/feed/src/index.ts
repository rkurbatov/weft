// The feed: a stream of keyed changes, and the machinery of following one.
//
// A table produces a feed, the wire ships one, the relational layer reads one,
// the dialect wraps one. Four consumers of one contract — so it is a package
// with a door, not an internal a neighbour reaches into.

export type { Key, Change, Feed, Follower } from './shape.ts'
export { follow, changeLog, KEEP } from './follow.ts'
export type { ChangeLog } from './follow.ts'
