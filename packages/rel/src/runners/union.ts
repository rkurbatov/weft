// Two streams into one, on the promise that they do not overlap.
//
// A key is the identity of a row here, so the same key on both sides would be
// one row claiming to be two. Which side holds which key is therefore tracked,
// and a collision is named rather than silently resolved — the corpus promises
// this, and a quiet winner would be a bug nobody could see.

import type { UnionNode } from '../node.ts'
import type { Change } from '#feed'
import type { Key } from '#feed'
import type { Row } from '../expr.ts'
import type { Make, Runner } from './runner.ts'

const LEFT = 1
const RIGHT = 2

const collision = (key: Key): Error =>
  new Error(`weft rel: union key collision on ${String(key)} — sides must be disjoint`)

export function unionRunner(node: UnionNode, make: Make): Runner {
  const left = make(node.left)
  const right = make(node.right)
  const side = new Map<Key, number>()

  const land = (changes: Change<Row>[], bit: number): Change<Row>[] => {
    for (const change of changes) {
      if (change.prev !== undefined && change.next === undefined) {
        const held = (side.get(change.key) ?? 0) & ~bit
        if (held === 0) side.delete(change.key)
        else side.set(change.key, held)
      } else if (change.prev === undefined && change.next !== undefined) {
        const held = (side.get(change.key) ?? 0) | bit
        if (held === (LEFT | RIGHT)) throw collision(change.key)
        side.set(change.key, held)
      }
    }
    return changes
  }

  return {
    feed(from, changes) {
      return [...land(left.feed(from, changes), LEFT), ...land(right.feed(from, changes), RIGHT)]
    },
    rebuild(sources) {
      side.clear()
      const out = left.rebuild(sources)
      for (const key of out.keys()) side.set(key, LEFT)
      for (const [key, row] of right.rebuild(sources)) {
        if (side.has(key)) throw collision(key)
        side.set(key, RIGHT)
        out.set(key, row)
      }
      return out
    },
  }
}
