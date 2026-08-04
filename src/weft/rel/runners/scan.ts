// An ordered pass with a running measure: rank, running totals, offsets.
//
// Two decisions belong to the planner here, not to the caller: what holds the
// line, and whether the carry is written into the rows at all. Writing it
// materialises the tail — three orders of magnitude on a long list — so past a
// threshold the plan takes the materialisation away and answers offsets on
// demand instead.

import { offsets } from '../../core/table/offsets.ts'
import { planScan } from '../../core/table/plan.ts'
import type { ScanCarrier, ScanForm } from '../../core/table/plan.ts'
import type { Change, Key } from '../../core/table/table.ts'
import type { Row } from '../expr.ts'
import { orderCompare, stepOf } from '../node.ts'
import type { ScanNode } from '../node.ts'
import type { Make, Ordering, Runner } from './runner.ts'

export function scanRunner(node: ScanNode, make: Make): Runner {
  const input = make(node.input)
  // The pass, in order: rows by place, and their steps as a line of numbers.
  let placed: Array<{ key: Key; row: Row }> = []
  let line = offsets()
  let carrier: ScanCarrier = 'tail'
  let form: ScanForm = 'asked'
  let announced = false

  const compare = (a: { key: Key; row: Row }, b: { key: Key; row: Row }): number =>
    orderCompare(node.order, a.row, b.row) || (String(a.key) < String(b.key) ? -1 : 1)

  /** Where a row sits, or where it would sit — binary search over the pass. */
  const placeOf = (probe: { key: Key; row: Row }): number => {
    let low = 0
    let high = placed.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (compare(placed[mid] as { key: Key; row: Row }, probe) < 0) low = mid + 1
      else high = mid
    }
    return low
  }

  const carryAt = (at: number): number => (node.from ?? 0) + line.offsetOf(at)

  const marked = (at: number): Row => {
    const { row } = placed[at] as { key: Key; row: Row }
    if (form === 'asked') return row
    const before = carryAt(at)
    const out: Row = { ...row }
    if (node.as !== undefined) out[node.as] = before
    if (node.through !== undefined) out[node.through] = before + stepOf(node, row)
    return out
  }

  const plan = (): void => {
    const decided = planScan(`scan.${node.as ?? node.order[0]?.field ?? 'order'}`, {
      size: placed.length,
      numeric: true,
      named: node.as !== undefined || node.through !== undefined,
      ...(announced ? { forced: carrier } : {}),
    })
    carrier = decided.carrier
    form = decided.form
    announced = true
  }

  const places = new Map<Key, Row>() // rows by key, for placeOf by key
  const viewOf = (): Ordering => ({
    offsetAt: at => carryAt(at),
    offsetOf(key) {
      const row = places.get(key)
      if (row === undefined) return null
      const at = placeOf({ key, row })
      return (placed[at] as { key: Key } | undefined)?.key === key ? carryAt(at) : null
    },
    at(point) {
      if (placed.length === 0) return null
      let low = 0
      let high = placed.length
      while (low < high) {
        const mid = (low + high) >> 1
        if (carryAt(mid) <= point) low = mid + 1
        else high = mid
      }
      const at = Math.max(0, low - 1)
      return { place: at, key: (placed[at] as { key: Key }).key, into: point - carryAt(at) }
    },
    keyAt: at => (placed[at] as { key: Key } | undefined)?.key ?? null,
    placeOf(key) {
      const row = places.get(key)
      if (row === undefined) return null
      const at = placeOf({ key, row })
      return (placed[at] as { key: Key } | undefined)?.key === key ? at : null
    },
    extent: () => (node.from ?? 0) + line.total(),
    size: () => placed.length,
  })

  return {
    get view() {
      return viewOf()
    },
    feed(from, changes) {
      // A row leaving or arriving shifts every place after it — the tail is
      // what a scan owes, and the line pays it as a point update. A row that
      // stayed in its place is a measurement, not a move.
      //
      // Whole batches go in as one: applying a hundred arrivals one by one
      // costs a hundred splices of the pass and a hundred stale marks on the
      // line, which is how a live feed pushing rows on top ended up the one
      // scene this lost. Past a handful, the pass is rebuilt once instead —
      // the same single linear walk the hand-written layouts pay.
      const gone = new Map<Key, Row>()
      const landed = new Map<Key, Row>()
      const moves: Array<Change<Row>> = []
      let earliest = placed.length
      let touched = false

      for (const change of input.feed(from, changes)) {
        if (change.prev !== undefined && change.next !== undefined) {
          const at = placeOf({ key: change.key, row: change.prev })
          if (
            (placed[at] as { key: Key } | undefined)?.key === change.key &&
            orderCompare(node.order, change.prev, change.next) === 0
          ) {
            placed[at] = { key: change.key, row: change.next }
            places.set(change.key, change.next)
            line.measure(at, stepOf(node, change.next))
            earliest = Math.min(earliest, at)
            touched = true
            landed.set(change.key, change.next)
            continue
          }
        }
        moves.push(change)
      }

      const BATCH = 8
      if (moves.length >= BATCH) {
        // One pass: fold every move into the map of rows, then sort once.
        for (const change of moves) {
          if (change.next === undefined) {
            if (places.delete(change.key) && change.prev !== undefined) {
              gone.set(change.key, change.prev)
            }
          } else {
            places.set(change.key, change.next)
            gone.delete(change.key)
            landed.set(change.key, change.next)
          }
        }
        // The pass is already in order; only the batch needs sorting, and the
        // two are merged in one walk — n + m, not n log n.
        const fresh = [...landed].map(([key, row]) => ({ key, row }))
        fresh.sort(compare)
        const kept = placed.filter(one => places.get(one.key) === one.row)
        const merged: Array<{ key: Key; row: Row }> = []
        let a = 0
        let b = 0
        let at = 0
        while (a < kept.length && b < fresh.length) {
          const left = kept[a] as { key: Key; row: Row }
          const right = fresh[b] as { key: Key; row: Row }
          merged[at++] = compare(left, right) <= 0 ? (a++, left) : (b++, right)
        }
        while (a < kept.length) merged[at++] = kept[a++] as { key: Key; row: Row }
        while (b < fresh.length) merged[at++] = fresh[b++] as { key: Key; row: Row }
        placed = merged
        line = offsets(placed.map(one => stepOf(node, one.row)))
        earliest = 0
        touched = touched || moves.length > 0
      } else {
        for (const change of moves) {
          if (change.prev !== undefined) {
            const at = placeOf({ key: change.key, row: change.prev })
            if (placed[at]?.key === change.key) {
              placed.splice(at, 1)
              line.remove(at)
              places.delete(change.key)
              earliest = Math.min(earliest, at)
              touched = true
              if (change.next === undefined) gone.set(change.key, change.prev)
            }
          }
          if (change.next !== undefined) {
            const one = { key: change.key, row: change.next }
            const at = placeOf(one)
            placed.splice(at, 0, one)
            places.set(change.key, change.next)
            line.insert(at, [stepOf(node, change.next)])
            earliest = Math.min(earliest, at)
            touched = true
            gone.delete(change.key)
            landed.set(change.key, change.next)
          }
        }
      }

      if (!touched) return []
      const out: Change<Row>[] = []
      for (const [key, prev] of gone) out.push({ key, prev })
      if (form === 'asked') {
        // The carry lives in the line, not in the rows, so a shift below is
        // nobody's business but the line's: only the rows that actually
        // changed travel. This is the whole difference the bench measured.
        for (const [key, row] of landed) {
          const at = placeOf({ key, row })
          if ((placed[at] as { key: Key } | undefined)?.key === key) {
            out.push({ key, next: marked(at) })
          }
        }
        return out
      }
      // Stored: everything from the earliest touch on carries a new answer.
      for (let at = earliest; at < placed.length; at++) {
        out.push({ key: (placed[at] as { key: Key }).key, next: marked(at) })
      }
      return out
    },
    rebuild(sources) {
      const under = input.rebuild(sources)
      placed = [...under].map(([key, row]) => ({ key, row }))
      placed.sort(compare)
      places.clear()
      for (const one of placed) places.set(one.key, one.row)
      line = offsets(placed.map(one => stepOf(node, one.row)))
      plan()
      const out = new Map<Key, Row>()
      for (let at = 0; at < placed.length; at++) {
        out.set((placed[at] as { key: Key }).key, marked(at))
      }
      return out
    },
  }
}
