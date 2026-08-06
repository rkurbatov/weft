// The worker's side: build the engine, put its face on the wire, wait.
//
// `self` is a wire like any other — it posts and it listens — so there is no
// casting here either. Nothing in this file is about the demo: it is what any
// application with state in a worker writes once.

import { offer, overWire } from '#loom'
import { engine } from './state.ts'

const held = engine()

offer(
  {
    // Offered as views because a panel shows them, and the pattern is offered
    // as a fact as well because a panel writes it. A fact alone is write-only.
    views: {
      matches: held.matches,
      shape: held.shape,
      ticks: held.ticks,
      needle: held.needle,
      size: held.size,
    },
    facts: { needle: held.needle, size: held.size },
  },
  overWire(self),
)
