// The same by hand: restore on start, write on every change, swallow neither.
// Small here — and synchronous, which is exactly why this state could never
// live on a worker's side.

import { useState } from 'react'

const KEY = 'draft-demo-classic'

export function App() {
  const [draft, setDraft] = useState(() => {
    try {
      return localStorage.getItem(KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [trouble, setTrouble] = useState<string | undefined>(undefined)

  const edit = (text: string): void => {
    setDraft(text)
    try {
      localStorage.setItem(KEY, text)
      setTrouble(undefined)
    } catch (error) {
      setTrouble(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <main className="draft">
      <h1>A draft that survives</h1>
      <p className="which">
        By hand: restored on start, written on every change, with the write failure caught so a full
        store does not lose the text in silence.
      </p>
      <textarea
        value={draft}
        onChange={event => edit(event.target.value)}
        placeholder="Type here, reload the page — it is still here."
      />
      <p className="status">
        {trouble === undefined ? (
          'saved as you type'
        ) : (
          <span className="bad">not saving: {trouble}</span>
        )}
      </p>
    </main>
  )
}
