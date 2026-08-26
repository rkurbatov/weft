// The worker's side: build the engine, put its face on the wire, wait.
//
// `self` is a wire like any other. Nothing here is about the demo — it is what
// any application with state in a worker writes once.

import { cell, every, offer } from '#loom'
import { overWire } from '#weft'
import { engine } from './state.ts'

const held = engine()

// The pace Retex asks for: ten a second, not a thousand. The counter beside it
// is the evidence — the page shows computed against sent, and the two numbers
// are meant to disagree.
const sent = cell(0, { name: 'sent' })
const paced = every(100)
const schedule = (work: () => void): void => {
  sent.set(sent.peek() + 1)
  paced(work)
}

offer(
  {
    // Offered as views because the panel shows them, and the two ports are
    // offered as facts as well because the panel writes them. A fact alone
    // would be write-only — the panel would have nothing to read back.
    views: {
      found: held.found,
      corpusBytes: held.corpusBytes,
      // Counters the library keeps, published like anything else.
      asked: held.tally.asked,
      published: held.tally.published,
      calledOff: held.tally.calledOff,
      answered: held.tally.answered,
      needle: held.needle,
      size: held.size,
      // The pace made visible: how many packets the wire actually carried,
      // against how many searches ran. The two are meant to disagree.
      sent,
    },
    facts: { needle: held.needle, size: held.size },
  },
  overWire(self),
  { schedule },
)
