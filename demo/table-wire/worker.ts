// The desk's side: build it, put its face on the wire, wait.

import { offer, overWire } from '#loom'
import { desk } from './state.ts'

const held = desk()

offer(
  {
    views: {
      // Only the window crosses. The table itself stays here — a hundred
      // thousand rows have no business on a wire because somebody scrolled.
      window: held.window,
      size: held.size,
      crossed: held.crossed,
      from: held.from,
      span: held.span,
    },
    facts: { from: held.from, span: held.span },
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
