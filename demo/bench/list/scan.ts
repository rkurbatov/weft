// The same flat line, reached the other way: not by calling a carrier, but by
// declaring a scan and letting the layer pick one. Underneath both this and
// `flat.ts` sits `offsets`; what this row measures is the price of the layer
// above it — a source table, changes travelling by rule, a derived table with
// subscribers, and an application that never names a data structure.
//
// The scenes are translated, not identical, and the table says so: a list's
// `measure(i, h)` becomes an edit of that row in the source table, and
// `prepend(hs)` becomes a hundred rows entering with smaller ranks. The
// answers are the same answers; the calls are the calls an application makes.
//
// WHAT THIS ROW FOUND FIRST, and it was a finding about the design, not the
// code — since fixed by the plan's `form`, kept here as the reason it exists:
// a scan that writes the carry INTO EVERY ROW materialises its own tail. One
// row growing near the top gives every row below it a new offset, so an edit
// that costs `offsets` a point update costs this a rewrite of the tail — the
// numbers below are three orders of magnitude apart for exactly that reason,
// and no tuning of this adapter closes the gap. The granularity law says the
// same thing from the other side: a carry per row is a field nobody looks at
// one by one. The fix is not a faster carrier — both sides already share the
// same one — but a scan that answers offsets ON DEMAND (a view with
// `offsetOf`/`at`) instead of storing them, keeping the materialised form for
// the case it is actually for: a short ordered list whose running total is
// shown, like a ledger's balance column. That is now what happens: naming no
// carry field leaves the numbers in the line, the plan says `asked`, and only
// the rows that truly changed travel. What is left in this row's column is
// the layer's own price — a table, changes by rule, subscribers — against a
// carrier called directly.

import { table, watch } from '#weft'
import type { Key } from '#weft'
import { from } from '#rel'
import type { Ordering, Row } from '#rel'
import type { List } from './classic.ts'

interface ListRow {
  id: number
  rank: number
  height: number
}

export function scanList(heights: number[]): List {
  const rows = table<Row>({ key: r => r['id'] as Key, name: 'rows' })
  rows.put(...heights.map((height, i) => ({ id: i, rank: i, height })))

  // No carry field is named: the screen wants offsets, not a number in every
  // row. The plan sees that and keeps the carry in the line.
  const live = from<ListRow>('rows', 'id').scan({ by: 'rank', step: 'height' }).live({ rows })
  // Demand, the way a screen actually holds it: a virtualised list never
  // watches the whole array — it watches the size and asks the view for the
  // window it draws. Watching `all` here would rebuild a 20k-row array on
  // every edit and drown what the scan itself costs.
  const stop = watch(() => {
    live.size.get()
  })

  let nextId = heights.length
  let top = 0 // prepended rows walk their ranks downwards
  const order = (): Ordering => live.order as Ordering

  return {
    offsetOf(index) {
      const key = order().keyAt(index)
      return key === null ? 0 : (order().offsetOf(key) ?? 0)
    },
    at(pixel) {
      const found = order().at(pixel)
      return found === null ? { index: -1, into: pixel } : { index: found.place, into: found.into }
    },
    measure(index, height) {
      const key = order().keyAt(index)
      if (key === null) return
      const row = live.row(key).peek() as ListRow | undefined
      if (row !== undefined) rows.put({ id: row.id, rank: row.rank, height })
    },
    prepend(fresh) {
      const put: Row[] = []
      for (const height of fresh) {
        top -= 1
        put.push({ id: nextId++, rank: top, height })
      }
      rows.put(...put)
    },
    size: () => order().size(),
    // The layer's own accounting lives behind onScanPlan and the journal;
    // this column stays empty rather than pretending to compare.
    walked: () => 0,
    resetWalked: () => {},
    close: () => {
      stop()
      live.dispose()
      rows.dispose()
    },
  }
}
