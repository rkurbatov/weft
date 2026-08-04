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
// WHAT THIS ROW FOUND, and it is a finding about the design, not the code:
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
// shown, like a ledger's balance column.

import { table, watch } from '#weft'
import type { Key } from '#weft'
import { from } from '#weft/rel'
import type { Row } from '#weft/rel'
import type { List } from './classic.ts'

interface ListRow {
  id: number
  rank: number
  height: number
}
type Placed = ListRow & { offset: number; end: number }

export function scanList(heights: number[]): List {
  const rows = table<Row>({ key: r => r['id'] as Key, name: 'rows' })
  rows.put(...heights.map((height, i) => ({ id: i, rank: i, height })))

  const live = from<ListRow>('rows', 'id')
    .scan({ by: 'rank', step: 'height', as: 'offset', through: 'end' })
    .live({ rows })
  // A screen watches; without demand nothing feeds at all.
  const stop = watch(() => {
    live.all.get()
  })

  // A cheap stamp: the derived table's row objects change identity on every
  // change, so one of them plus the size is enough to notice movement.
  let ticks = 0
  const bump = watch(() => {
    live.all.get()
    ticks++
  })
  const version = (): number => ticks

  let nextId = heights.length
  let top = 0 // prepended rows walk their ranks downwards

  // Sorted once per change, not per question: the layer's version tells us
  // when the answer moved. Without this the adapter's own sort would drown
  // whatever the layer costs.
  let sorted: Placed[] = []
  let seenAt = -1
  const ordered = (): Placed[] => {
    const now = live.size.peek() + (live.all.peek().length === 0 ? 0 : 0)
    void now
    const stamp = version()
    if (stamp !== seenAt) {
      sorted = [...(live.all.peek() as readonly Placed[])].toSorted((a, b) => a.rank - b.rank)
      seenAt = stamp
    }
    return sorted
  }

  return {
    offsetOf(index) {
      return ordered()[index]?.offset ?? 0
    },
    at(pixel) {
      // The layer answers by row; the hit test is the screen's own search.
      const all = ordered()
      let low = 0
      let high = all.length
      while (low < high) {
        const mid = (low + high) >> 1
        if ((all[mid] as Placed).offset <= pixel) low = mid + 1
        else high = mid
      }
      const at = Math.max(0, low - 1)
      const row = all[at]
      return row === undefined
        ? { index: -1, into: pixel }
        : { index: at, into: pixel - row.offset }
    },
    measure(index, height) {
      const row = ordered()[index]
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
    size: () => live.size.peek(),
    // The layer's own accounting lives behind onScanPlan and the journal;
    // this column stays empty rather than pretending to compare.
    walked: () => 0,
    resetWalked: () => {},
    close: () => {
      bump()
      stop()
      live.dispose()
      rows.dispose()
    },
  }
}
