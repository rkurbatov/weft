// The data package: plain values everything else is built from, and the one
// channel the library speaks through when it decides something itself.
//
// Knows nothing — not the graph, not tables, not the wire. That is what lets
// structural sharing be used by a projection, by a mirror and by an assembled
// view without any of them knowing about each other.

export type { Key } from './key.ts'
export { preserve, PRESERVE_LIMIT } from './preserve.ts'
export { notice, onNotice, forgetNotices } from './notice.ts'
export type { Notice, Level } from './notice.ts'
export { laneAppend, laneDrop, laneFind, lanePlace } from './arrange.ts'
export { backoff } from './backoff.ts'
export type { Lanes } from './arrange.ts'
