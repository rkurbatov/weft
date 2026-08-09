// The machine room: what the library is made of, not what it offers.
//
// Structural sharing, backoff arithmetic, an injectable clock, and the channel
// the library speaks its own decisions on. Four pieces of machinery with one
// thing in common — every layer above is built out of them, and none of them
// is anybody's subject. A person writing an application never
// asks for structural sharing; they ask for a row that did not change to stay
// the same object, which is a promise the layers above make using this.
//
// Nothing here crosses the front door under its own name. `#weft` imports
// `#core` not once, and a stand doing so is a boundary-test failure — which is
// what makes "the machinery is hidden" a checkable claim rather than a habit.
//
// The one thing an application does need from here is the listening half of
// the notice channel, and it does not come from here: the graph owns the
// subject — explaining what the library decided — and hands `onNotice` out as
// part of it. A name reaches the front door through whoever owns its subject,
// never straight out of the machine room. The channel itself lives down here
// because `preserve` speaks on it, and `preserve` is below the graph.

export { notice, onNotice, forgetNotices } from './notice.ts'
export type { Notice, Level } from './notice.ts'
export { preserve, PRESERVE_LIMIT } from './preserve.ts'
export { backoff } from './backoff.ts'
export { wallClock } from './time.ts'
export type { Now, Timers } from './time.ts'
