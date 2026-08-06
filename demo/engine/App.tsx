// The panel: a search box over a log that lives in another thread.
//
// Every read goes through the station cell rather than through a prop, so
// replacing the worker is seen here the way any other change is seen. What a
// visitor should be able to tell without reading code:
//   — typing searches two hundred thousand lines and the box never stutters,
//     because the searching happens elsewhere;
//   — hiding the results stops the searching altogether;
//   — killing the worker loses nothing: the panel asks again by itself.

import { useState } from 'react'
import type { ReactNode } from 'react'
import { useLive } from '#loom/react'
import { replace, station } from './main.tsx'
import type { Found } from './state.ts'

/** The results, and the only thing on this page that watches the engine. */
function Results({ needle }: { needle: string }): ReactNode {
  const found = useLive(() => station.get().engine.view<Found>('found').get())

  if (needle === '') {
    return (
      <p className="dim">
        Type something above — try <code>declined</code>, <code>[db]</code> or <code>slow</code>.
      </p>
    )
  }
  if (found === undefined) return <p className="dim">asking the worker…</p>
  if (found.total === 0) {
    // Nothing found *yet* is not nothing found: a run over part of the log is
    // a real answer, and saying "no matches" while it goes on would be a lie.
    return found.done ? (
      <p className="dim">Nothing matched “{needle}”.</p>
    ) : (
      <p className="dim">
        searching… {found.seen.toLocaleString('en')} of {found.of.toLocaleString('en')} lines
      </p>
    )
  }

  return (
    <>
      <p className="summary">
        <b>{found.total.toLocaleString('en')}</b> matching lines in{' '}
        <b>{found.seen.toLocaleString('en')}</b> of {found.of.toLocaleString('en')} searched
        {found.done ? '' : ' — still going'}, {found.ms.toFixed(0)} ms
        {found.total > found.lines.length ? ', first fifty shown' : ''}
      </p>
      <ol className="lines">
        {found.lines.map(line => (
          <li key={line.id}>
            <span className="no">{line.id}</span>
            {line.text}
          </li>
        ))}
      </ol>
    </>
  )
}

export function App(): ReactNode {
  const [typed, setTyped] = useState('')
  const [showing, setShowing] = useState(true)
  const steps = useLive(() => station.get().engine.view<number>('steps').get())
  const abandoned = useLive(() => station.get().engine.view<number>('abandoned').get())
  const sent = useLive(() => station.get().engine.view<number>('sent').get())
  const echoed = useLive(() => station.get().engine.view<string>('needle').get())

  return (
    <main className="engine">
      <h1>Searching a log that lives in another thread</h1>
      <p className="story">
        Two hundred thousand lines of made-up service log are held by a worker, and so is the search
        over them. This page holds nothing but a mirror of the answer. Type below: the box never
        stutters, because nothing here is doing the searching.
      </p>

      <div className="row">
        <label className="grow">
          find lines containing{' '}
          <input
            value={typed}
            autoFocus
            onChange={event => {
              setTyped(event.target.value)
              station.peek().engine.write('needle', event.target.value)
            }}
            placeholder="declined"
          />
        </label>
      </div>

      <div className="row numbers">
        <span>
          the worker is searching for <b>{echoed === undefined ? '—' : `“${echoed}”`}</b>
        </span>
        <span>
          it published <b>{steps ?? '—'}</b> chunks, and <b>{abandoned ?? '—'}</b> runs were called
          off
        </span>
        <span>
          and the wire carried <b>{sent ?? '—'}</b> packets
        </span>
      </div>

      <div className="row">
        <button type="button" onClick={() => setShowing(open => !open)}>
          {showing ? 'hide the results' : 'show the results'}
        </button>
        <button type="button" onClick={() => replace(typed)}>
          kill the worker
        </button>
      </div>

      <div className="results">
        {showing ? (
          <Results needle={typed} />
        ) : (
          <p className="dim">
            Results hidden — and the worker has stopped searching. Type anything: the counter above
            will not move until you show them again. Nothing asked for, nothing computed.
          </p>
        )}
      </div>

      <p className="story small">
        Killing the worker raises a new one with an empty head: the search counter goes back to
        zero, the panel says the pattern again, and the results return on their own — without
        touching the buttons. There is no reconnect code and no error handling on this page.
      </p>
    </main>
  )
}
