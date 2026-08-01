// The state, with no React in it: one stored cell, kept. This file could load
// on a worker's side unchanged; the screen only reads it.

import { input, keepInput } from '#weft'
import type { Kept, Store } from '#weft'

export function draftState(store: Store) {
  const draft = input('', { name: 'draft' })
  const kept: Kept = keepInput(draft, { key: 'draft', store })
  return { draft, kept }
}
