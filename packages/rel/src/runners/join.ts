// Joining, kept incrementally and without double counting.
//
// The order is the whole trick: a batch goes through the left side against the
// previous right index, then the right side against the already-updated left —
// the derivative of a product, which is also what makes a self-join behave.

import type { Change, Key } from '#table/table.ts'
import type { Row } from '../expr.ts'
import { keyOfRow, mergedRow, onKeyOf, passesResidual, oracle } from '../node.ts'
import type { JoinNode } from '../node.ts'
import { notice } from '#data/notice.ts'
import { diffInto } from './runner.ts'
import type { Make, Runner } from './runner.ts'

type OnIndex = Map<string | number, Map<Key, Row>>

/**
 * How many rows may gather under one key before the join says something.
 *
 * A join on a low-cardinality field — a status, a flag, a tenant — is not a
 * mistake in itself, but it is rarely what was meant: one row arriving on the
 * other side then makes as many rows as there are here. Nothing is refused;
 * this is a word of warning, once per key, through the same door the planner's
 * decisions go.
 */
export const CROWDED_KEY = 10_000

const put = (
  index: OnIndex,
  at: string | number,
  key: Key,
  row: Row,
  warn?: (at: string | number, rows: number) => void,
): void => {
  let held = index.get(at)
  if (held === undefined) {
    held = new Map()
    index.set(at, held)
  }
  const was = held.size
  held.set(key, row)
  if (warn !== undefined && was < CROWDED_KEY && held.size >= CROWDED_KEY) warn(at, held.size)
}

const cut = (index: OnIndex, at: string | number, key: Key): void => {
  const held = index.get(at)
  if (held === undefined) return
  held.delete(key)
  if (held.size === 0) index.delete(at)
}

export function joinRunner(node: JoinNode, make: Make): Runner {
  const left = make(node.left)
  const right = make(node.right)
  const named = `${node.as} on ${node.on.map(pair => `${pair.left}=${pair.right}`).join(', ')}`
  let warned = false
  // Said once per join, at the moment a key first crosses the line — not per
  // row, and not again for every key after.
  const crowd = (at: string | number, rows: number): void => {
    if (warned) return
    warned = true
    notice({
      kind: 'crowded-join',
      where: named,
      level: 'warn',
      message:
        `the join "${named}" has ${rows} rows under the key ${String(at)} — one row arriving ` +
        `on the other side will make ${rows} rows here. Join on something more particular, ` +
        `or filter first.`,
      detail: { key: at, rows },
    })
  }
  // The indexes the derivative needs: each side's rows, grouped by equi-key.
  const leftByOn: OnIndex = new Map()
  const rightByOn: OnIndex = new Map()
  const leftKeyOf = (row: Row): Key => keyOfRow(node.left, row)
  const rightKeyOf = (row: Row): Key => keyOfRow(node.right, row)

  /** Everything one left row stands for right now: its pairs, or its phantom. */
  const outsOf = (leftRow: Row): Map<Key, Row> => {
    const out = new Map<Key, Row>()
    // A row with nothing in a key field matches nobody — including the other
    // rows that also have nothing. With `keeping` it still stands alone below.
    const at = onKeyOf(node.on, 'left', leftRow)
    for (const rightRow of (at === undefined ? undefined : rightByOn.get(at))?.values() ?? []) {
      const pair = mergedRow(node, leftRow, rightRow)
      if (!passesResidual(node, pair)) continue
      out.set(keyOfRow(node, pair), pair)
    }
    if (out.size === 0 && node.keeping === true) {
      const alone = mergedRow(node, leftRow, null)
      out.set(keyOfRow(node, alone), alone)
    }
    return out
  }

  const applyLeft = (out: Map<Key, Change<Row>>, change: Change<Row>): void => {
    const before = change.prev === undefined ? new Map<Key, Row>() : outsOf(change.prev)
    if (change.prev !== undefined) {
      const was = onKeyOf(node.on, 'left', change.prev)
      if (was !== undefined) cut(leftByOn, was, change.key)
    }
    if (change.next !== undefined) {
      const now = onKeyOf(node.on, 'left', change.next)
      // Not indexed at all when it has no key: an absence is not a bucket.
      if (now !== undefined) put(leftByOn, now, change.key, change.next, crowd)
    }
    const after = change.next === undefined ? new Map<Key, Row>() : outsOf(change.next)
    diffInto(out, before, after)
  }

  const applyRight = (out: Map<Key, Change<Row>>, change: Change<Row>): void => {
    // The left rows this change can touch: the partners of its old and new keys.
    const touched = new Map<Key, Row>()
    for (const side of [change.prev, change.next]) {
      if (side === undefined) continue
      const at = onKeyOf(node.on, 'right', side)
      if (at === undefined) continue
      for (const [key, row] of leftByOn.get(at) ?? []) {
        touched.set(key, row)
      }
    }
    const before = new Map<Key, Map<Key, Row>>()
    for (const [key, row] of touched) before.set(key, outsOf(row))
    if (change.prev !== undefined) {
      const was = onKeyOf(node.on, 'right', change.prev)
      if (was !== undefined) cut(rightByOn, was, change.key)
    }
    if (change.next !== undefined) {
      const now = onKeyOf(node.on, 'right', change.next)
      if (now !== undefined) put(rightByOn, now, change.key, change.next, crowd)
    }
    for (const [key, row] of touched) {
      diffInto(out, before.get(key) as Map<Key, Row>, outsOf(row))
    }
  }

  return {
    feed(from, changes) {
      // Left against the right index as it was, then right against the left
      // index as it now is — the bilinear derivative, in that order.
      const leftIn = left.feed(from, changes)
      const rightIn = right.feed(from, changes)
      const out = new Map<Key, Change<Row>>()
      for (const change of leftIn) applyLeft(out, change)
      for (const change of rightIn) applyRight(out, change)
      const landed: Change<Row>[] = []
      for (const change of out.values()) {
        if (change.prev === undefined && change.next === undefined) continue
        landed.push(change)
      }
      return landed
    },
    rebuild(sources) {
      leftByOn.clear()
      rightByOn.clear()
      for (const row of left.rebuild(sources).values()) {
        const at = onKeyOf(node.on, 'left', row)
        if (at !== undefined) put(leftByOn, at, leftKeyOf(row), row, crowd)
      }
      for (const row of right.rebuild(sources).values()) {
        const at = onKeyOf(node.on, 'right', row)
        if (at !== undefined) put(rightByOn, at, rightKeyOf(row), row, crowd)
      }
      return oracle(node, sources)
    },
  }
}
