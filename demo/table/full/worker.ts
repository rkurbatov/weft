// The desk's side: hold the table, offer it, and keep working.
//
// The table is offered as a table, not as a value: a follower gets one
// snapshot and then batches of what changed. Nothing here decides how that
// travels — that is the protocol's business, and this file is four lines.

import { gauge, offer, overWire } from '#loom'
import { desk } from './state.ts'

const held = desk()
const busy = gauge().counts

offer(
  {
    views: {
      size: held.size,
      poured: held.poured,
      edited: held.edited,
      recomputed: busy.computed,
      woken: busy.woken,
    },
    tables: { jobs: held.jobs },
    acts: {
      pour: (count: number) => held.pour(count),
      touch: (count: number) => held.touch(count),
    },
  },
  overWire(self),
)
