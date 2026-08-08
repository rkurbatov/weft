// The desk's side: build it, put its face on the wire, wait.

import { counters, listed, offer, overWire } from '#loom'
import { desk } from './state.ts'

const held = desk()

// What the graph on this side is doing, as cells. Not counted by hand here:
// the library keeps these, and a page that counted them itself is how two
// bugs got in.
const busy = counters()

offer(
  {
    views: {
      size: held.size,
      from: held.from,
      span: held.span,
      recomputed: busy.computed,
      woken: busy.woken,
    },
    facts: { from: held.from, span: held.span },
    // The window travels as a difference: scrolling by one row sends one row,
    // not a screenful. Only what is visible ever crosses — the table itself
    // stays on this side.
    lists: { window: listed(held.window, row => row.id) },
    acts: {
      // Editing a row: the panel sends the new title, the desk writes it.
      rename: (id: number, title: string) => {
        const row = held.rows.row(id).peek()
        if (row !== undefined) held.rows.put({ ...row, title })
      },
    },
  },
  overWire(self),
)
