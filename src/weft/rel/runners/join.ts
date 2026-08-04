// Joining, kept incrementally and without double counting.
//
// The order is the whole trick: a batch goes through the left side against the
// previous right index, then the right side against the already-updated left —
// the derivative of a product, which is also what makes a self-join behave.

import type { Change, Key } from '../../core/table/table.ts'
import type { Row } from '../expr.ts'
import { keyOfRow, mergedRow, onKeyOf, passesResidual, recount } from '../node.ts'
import type { JoinNode } from '../node.ts'
import { diffInto } from './runner.ts'
import type { Make, Runner } from './runner.ts'

type OnIndex = Map<string, Map<Key, Row>>

const put = (index: OnIndex, at: string, key: Key, row: Row): void => {
  let held = index.get(at)
  if (held === undefined) {
    held = new Map()
    index.set(at, held)
  }
  held.set(key, row)
}

const cut = (index: OnIndex, at: string, key: Key): void => {
  const held = index.get(at)
  if (held === undefined) return
  held.delete(key)
  if (held.size === 0) index.delete(at)
}

export function joinRunner(node: JoinNode, make: Make): Runner {
  const left = make(node.left)
  const right = make(node.right)
  // The indexes the derivative needs: each side's rows, grouped by equi-key.
  const leftByOn: OnIndex = new Map()
  const rightByOn: OnIndex = new Map()
  const leftKeyOf = (row: Row): Key => keyOfRow(node.left, row)
  const rightKeyOf = (row: Row): Key => keyOfRow(node.right, row)

  /** Everything one left row stands for right now: its pairs, or its phantom. */
  const outsOf = (leftRow: Row): Map<Key, Row> => {
    const out = new Map<Key, Row>()
    for (const rightRow of rightByOn.get(onKeyOf(node.on, 'left', leftRow))?.values() ?? []) {
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
      cut(leftByOn, onKeyOf(node.on, 'left', change.prev), change.key)
    }
    if (change.next !== undefined) {
      put(leftByOn, onKeyOf(node.on, 'left', change.next), change.key, change.next)
    }
    const after = change.next === undefined ? new Map<Key, Row>() : outsOf(change.next)
    diffInto(out, before, after)
  }

  const applyRight = (out: Map<Key, Change<Row>>, change: Change<Row>): void => {
    // The left rows this change can touch: the partners of its old and new keys.
    const touched = new Map<Key, Row>()
    for (const side of [change.prev, change.next]) {
      if (side === undefined) continue
      for (const [key, row] of leftByOn.get(onKeyOf(node.on, 'right', side)) ?? []) {
        touched.set(key, row)
      }
    }
    const before = new Map<Key, Map<Key, Row>>()
    for (const [key, row] of touched) before.set(key, outsOf(row))
    if (change.prev !== undefined) {
      cut(rightByOn, onKeyOf(node.on, 'right', change.prev), change.key)
    }
    if (change.next !== undefined) {
      put(rightByOn, onKeyOf(node.on, 'right', change.next), change.key, change.next)
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
        put(leftByOn, onKeyOf(node.on, 'left', row), leftKeyOf(row), row)
      }
      for (const row of right.rebuild(sources).values()) {
        put(rightByOn, onKeyOf(node.on, 'right', row), rightKeyOf(row), row)
      }
      return recount(node, sources)
    },
  }
}
