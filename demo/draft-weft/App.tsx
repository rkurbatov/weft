// The whole screen. Restoring and saving are not in this file — or anywhere
// else in the demo — because keeping a cell is one line where it is declared.

import { idbStore } from '#weft'
import { useCell } from '#weft/react'
import { draftState } from './state.ts'

const state = draftState(idbStore('weft-demo-draft'))

export function App() {
  const draft = useCell(state.draft)
  const saving = useCell(state.kept.saving)

  return (
    <main className="draft">
      <h1>A draft that survives</h1>
      <p className="which">
        On weft: the draft is a stored cell, and keeping it is the one line in state.ts that says
        so. It lands in the browser's IndexedDB as you type.
      </p>
      <textarea
        value={draft}
        onChange={event => state.draft.set(event.target.value)}
        placeholder="Type here, reload the page — it is still here."
      />
      <p className="status">
        {saving.ok ? 'saved as you type' : <span className="bad">not saving: {saving.reason}</span>}
      </p>
    </main>
  )
}
