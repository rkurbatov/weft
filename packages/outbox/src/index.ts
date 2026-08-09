// Intents written down before they are sent, and what is made of them.
//
// A note goes into the book first and leaves it on confirmation; until then it
// is replayed over whatever the server says, so a screen shows the world as it
// will be. The lanes a person drags things between live here too: they are
// what an intent moves.

export { outbox } from './outbox.ts'
export type { Outbox, OutboxOptions, Note, NoteState, Handler } from './contract.ts'
export { projected } from './project.ts'
export type { ProjectionSpec } from './project.ts'
export { laneAppend, laneDrop, laneFind, lanePlace } from './arrange.ts'
export type { Lanes } from './arrange.ts'
