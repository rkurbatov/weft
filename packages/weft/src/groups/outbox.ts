// Intents written down before they are sent, and what is made of them.
//
// A note goes into the book first and leaves it on confirmation; until then it
// is replayed over whatever the server says, so a screen shows the world as it
// will be. The lanes a person drags things between are what an intent moves.

export { laneAppend, laneDrop, laneFind, lanePlace, outbox, projected } from '#outbox'
export type {
  Handler,
  Lanes,
  Note,
  NoteState,
  Outbox,
  OutboxOptions,
  ProjectionSpec,
} from '#outbox'
