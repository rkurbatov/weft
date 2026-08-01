// The screen of one window. The sheet itself lives in whichever window holds
// the lock; THIS window just watches mirrors and presses commands, and whether
// it also happens to be the one computing is a word in the corner.
//
// The tab's side of the wire is set up once, at module load — not in an
// effect. A closing tab says no goodbye (the hub's lease covers that), and an
// effect cleanup would kill the link on StrictMode's double mount.

import { useState } from 'react'
import { useCell } from '#weft/react'
import { columnName } from '../common/address.ts'
import { key } from '../common/sample.ts'
import { browserWorld, joinSheet } from './graph.ts'

const world = browserWorld()
const tab = joinSheet(world)
const readCell = tab.seen.command<[string], string>('textOf')
const writeCell = tab.seen.command<[string, string], void>('set')

export function App() {
  const role = useCell(tab.role)
  const [editing, setEditing] = useState('A1')
  const [text, setText] = useState('')

  const pick = (at: string): void => {
    setEditing(at)
    readCell(at).then(setText, () => setText(''))
  }

  const apply = (): void => {
    writeCell(editing, text).catch(() => {})
  }

  return (
    <main className="tabs-sheet">
      <header>
        <h1>One sheet, many windows</h1>
        <span className={role === 'leading' ? 'role lead' : 'role'}>
          this window is {role}
          {role === 'leading' ? ' — close it and watch the other take over' : ''}
        </span>
      </header>
      <p className="hint">
        Open this page in a second window. Click a cell, edit its text above, press Set — both
        windows follow, whichever one you typed in.
      </p>
      <div className="editor">
        <b>{editing}</b>
        <input
          type="text"
          value={text}
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') apply()
          }}
        />
        <button onClick={apply}>Set</button>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th />
            {Array.from({ length: world.shape.cols }, (_, col) => (
              <th key={col}>{columnName(col)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: world.shape.rows }, (_, row) => (
            <tr key={row}>
              <th>{row + 1}</th>
              {Array.from({ length: world.shape.cols }, (_, col) => (
                <Mirror
                  key={col}
                  at={key(row, col)}
                  picked={editing === key(row, col)}
                  onPick={pick}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  )
}

/** One cell of the grid: a mirror of the sheet's shown value, wherever it lives. */
function Mirror({
  at,
  picked,
  onPick,
}: {
  at: string
  picked: boolean
  onPick: (at: string) => void
}) {
  const shown = useCell(tab.seen.cell<string>('shown', at))
  return (
    <td className={picked ? 'picked' : undefined} onClick={() => onPick(at)}>
      {shown.value ?? ''}
    </td>
  )
}
