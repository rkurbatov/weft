// The desk's side: build it, put its face on the wire, wait.

import { listed, offer, overWire } from '#loom'
import { desk } from './state.ts'

const held = desk()

offer(
  {
    views: {
      size: held.size,
      from: held.from,
      span: held.span,
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
