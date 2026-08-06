// The worker's side: build the engine, put its face on the wire, wait.
//
// `self` is a wire like any other. Nothing here is about the demo — it is what
// any application with state in a worker writes once.

import { offer, overWire } from '#loom'
import { engine } from './state.ts'

const held = engine()

offer(
  {
    // Offered as views because the panel shows them, and the two ports are
    // offered as facts as well because the panel writes them. A fact alone
    // would be write-only — the panel would have nothing to read back.
    views: { found: held.found, searches: held.searches, needle: held.needle, size: held.size },
    facts: { needle: held.needle, size: held.size },
  },
  overWire(self),
)
