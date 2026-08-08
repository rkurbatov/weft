// Arranging by hand: ordered lanes a person drags things between.
//
// Beside the outbox rather than in the foundation: a board's lanes are what
// an intent moves, and the two are written together or not at all. They lived
// at the bottom of the stack for a while because they depend on nothing —
// which is a rule about dependencies, not about kinship.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { laneAppend } from '#keep'

describe('arranging by hand', () => {
  test('append puts a subject at the end of a lane, and only in one lane', () => {
    const lanes = { todo: ['a', 'b'], done: ['c'] }
    const after = laneAppend(lanes, 'c', 'todo')
    assert.deepEqual(after['todo'], ['a', 'b', 'c'])
    assert.deepEqual(after['done'], [], 'a subject stands in one place, not two')
  })

  test('appending what is already at the end changes nothing anybody can see', () => {
    const lanes = { todo: ['a', 'b'] }
    assert.deepEqual(laneAppend(lanes, 'b', 'todo')['todo'], ['a', 'b'])
  })
})
