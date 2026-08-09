// What the compiler says when a field name is wrong.
//
// The compiler is the test: `@ts-expect-error` fails the build if the line
// below it turns out to be legal. Nothing runs here — the point is the message
// a person gets, and that only exists at compile time.
//
// Before this, a wrong field said "not assignable to 'ScalarField<Task>'" —
// true, unhelpful, and for a wide row followed by every legal field name. Now
// the type carries the complaint in its own name, and a misspelling is told
// apart from a field of the wrong kind: the two are different mistakes and
// send a person looking in different places.

import { test } from 'node:test'
import { byEach, live } from '#loom'

interface Task {
  readonly id: number
  readonly title: string
  readonly owner: string
  readonly spent: number
  readonly tags: readonly string[]
}

test('a field name is judged, and the complaint says which way it is wrong', () => {
  const tasks = live<Task>({ name: 'fields.types.tasks', key: row => row.id })

  const fine = byEach(tasks, 'owner', g => ({ spent: g.sum('spent'), first: g.min('title') }))

  // @ts-expect-error — NoSuchField<"ownr">: a misspelling, not a wrong kind
  const misspelled = byEach(tasks, 'ownr', g => ({ n: g.count() }))

  // @ts-expect-error — NotANumberField<"title">: the field is there, it is text
  const notANumber = byEach(tasks, 'owner', g => ({ n: g.sum('title') }))

  // @ts-expect-error — NotAComparableField<"tags">: an array compares by reference
  const notComparable = byEach(tasks, 'tags', g => ({ n: g.count() }))

  void fine
  void misspelled
  void notANumber
  void notComparable
})
