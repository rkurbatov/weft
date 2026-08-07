// The panel: a search box over a log that lives in another thread.
//
// Every read goes through the station cell rather than through a prop, so
// replacing the worker is seen here the way any other change is seen. What a
// visitor should be able to tell without reading code:
//   — typing searches two million lines and the box never stutters, because
//     the searching happens elsewhere;
//   — the answer grows while the run goes on, and it is a real answer;
//   — hiding the results stops the searching altogether;
//   — killing the worker loses nothing: the panel asks again by itself.

import { useState } from 'react'
import type { ReactNode } from 'react'
import { useLive } from '#loom/react'
import { replace, station } from './main.tsx'
import type { Found } from './state.ts'
import { barHeights } from './bars.ts'
import { BUCKET_MS } from '../engine-common/corpus.ts'

const mb = (bytes: number | undefined): string =>
  bytes === undefined ? '—' : `${(bytes / 1024 / 1024).toFixed(0)} MB`

/** One number with its label, in the strip under the search box. */
function Count({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className="count">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  )
}

/**
 * Matches per bucket, drawn from the typed array the worker sends.
 *
 * The bars are the bulk data of order item 6 made visible: this is what
 * wire ten times a second, and it grows chunk by chunk while the run goes on.
 */
export function Histogram({ hist }: { hist: Float64Array }): ReactNode {
  const bars = barHeights(hist)
  const top = (bars.of ?? 0) * BUCKET_MS
  return (
    <figure className="hist">
      <div className="frame">
        {/* Two labels on the vertical: what the top and the bottom of the plot
            are worth. Between them the scale is logarithmic, so a midpoint
            would be a lie unless it were labelled too — and three numbers on a
            plot this small is a crowd. */}
        <div className="scale">
          <span>{bars.most.toLocaleString('en')}</span>
          <span>{bars.least.toLocaleString('en')}</span>
        </div>
        <div className="plot">
          {bars.heights.map((height, at) => (
            <div
              className="bar"
              key={`bucket-${String(at)}`}
              // The height is on the column itself, not on a child of it: a
              // child sized in percent of a parent with no height of its own
              // is exactly what once rendered as nothing.
              style={{ height: `${String(height)}%` }}
              title={`${String(at * BUCKET_MS)}–${String((at + 1) * BUCKET_MS)} ms: ${(
                hist[at] ?? 0
              ).toLocaleString('en')} matches`}
            />
          ))}
        </div>
      </div>
      <div className="axis">
        {[0, 0.25, 0.5, 0.75, 1].map(part => (
          <span key={part} style={{ left: `${String(part * 100)}%` }}>
            {part === 1 ? `${String(top / 1000)} s+` : duration(top * part)}
          </span>
        ))}
      </div>
      <figcaption>matches by how long the operation took · logarithmic scale</figcaption>
    </figure>
  )
}

/** A duration in the shortest form that still reads: 250 ms, 1.5 s. */
function duration(ms: number): string {
  return ms < 1000 ? `${String(Math.round(ms))} ms` : `${String(Math.round(ms) / 1000)} s`
}

/** The results, and the only thing on this page that watches the engine. */
function Results({ needle }: { needle: string }): ReactNode {
  const found = useLive(() => station.get().engine.view<Found>('found').get())

  if (needle === '') {
    return (
      <p className="dim">
        Type something above — try <code>declined</code>, <code>[db@</code> or <code>slow</code>.
      </p>
    )
  }
  if (found === undefined) {
    return <p className="dim">the worker is building four million lines of log…</p>
  }

  // Nothing found *yet* is not nothing found: a run over part of the log is a
  // real answer, and saying "no matches" while it goes on would be a lie.
  if (found.total === 0 && found.done) {
    return <p className="dim">Nothing matched “{needle}”.</p>
  }

  return (
    <>
      <p className="summary">
        <b>{found.total.toLocaleString('en')}</b> matches in{' '}
        <b>{found.seen.toLocaleString('en')}</b> of {found.of.toLocaleString('en')} lines
        {found.done ? '' : ' — still going'} · {found.ms.toFixed(0)} ms
        {found.total > found.lines.length ? ' · first fifty shown' : ''}
      </p>
      <Histogram hist={found.hist} />
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
  const asked = useLive(() => station.get().engine.view<number>('asked').get())
  const published = useLive(() => station.get().engine.view<number>('published').get())
  const corpusBytes = useLive(() => station.get().engine.view<number>('corpusBytes').get())
  const calledOff = useLive(() => station.get().engine.view<number>('calledOff').get())
  const answered = useLive(() => station.get().engine.view<number>('answered').get())
  const sent = useLive(() => station.get().engine.view<number>('sent').get())
  const echoed = useLive(() => station.get().engine.view<string>('needle').get())

  return (
    <main className="engine">
      <h1>Searching a log that lives in another thread</h1>

      <p className="story">
        Four million lines of made-up service log, searched by a worker in chunks. This page holds
        nothing but a mirror of the answer — which is why the box never stutters. The first search
        waits a few seconds while the worker builds the corpus; after that a search takes about a
        second, so typing another letter calls the running one off.
      </p>

      <div className="search">
        <input
          value={typed}
          autoFocus
          onChange={event => {
            setTyped(event.target.value)
            station.peek().engine.write('needle', event.target.value)
          }}
          placeholder="declined"
        />
        <button
          type="button"
          onClick={() => {
            // Typing faster than the search: eighty milliseconds a letter
            // against a search of half a second. Every letter but the last
            // calls off the run before it — which is the thing this page is
            // about and which nobody can demonstrate by hand reliably.
            const word = 'declined'
            for (let i = 1; i <= word.length; i++) {
              setTimeout(() => {
                const part = word.slice(0, i)
                setTyped(part)
                station.peek().engine.write('needle', part)
              }, i * 80)
            }
          }}
        >
          type fast
        </button>
        <button type="button" onClick={() => setShowing(open => !open)}>
          {showing ? 'hide results' : 'show results'}
        </button>
        <button type="button" onClick={() => replace(typed)}>
          kill the worker
        </button>
      </div>

      <div className="counts">
        <Count label="runs started" value={asked ?? '—'} />
        <Count label="runs finished" value={answered ?? '—'} />
        <Count label="runs called off" value={calledOff ?? '—'} />
        <Count label="chunks published" value={published ?? '—'} />
        <Count label="packets on the wire" value={sent ?? '—'} />
        <Count label="corpus in memory" value={mb(corpusBytes)} />
        <Count
          label="the worker is looking for"
          value={echoed === undefined || echoed === '' ? '—' : `“${echoed}”`}
        />
      </div>

      <div className="results">
        {showing ? (
          <Results needle={typed} />
        ) : (
          <p className="dim">
            Results hidden, and the worker has stopped searching: no demand, no work. Type anything
            — the counters stand still until you show them again.
          </p>
        )}
      </div>

      <p className="story small">
        Plain words are matched literally; anything with regex punctuation —{' '}
        <code>payment (declined|accepted)</code>, <code>error \[db@</code> — is matched as a regular
        expression. The log is one UTF-8 buffer with an index of line offsets: the same lines as
        JavaScript strings would cost six hundred megabytes instead of a hundred, and search three
        times slower. A line becomes a string only when it is shown. A run is <b>called off</b> when
        its answer stops being wanted — you typed another letter, or you hid the results.
      </p>
    </main>
  )
}
