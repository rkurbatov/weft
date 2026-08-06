// The panel: a mirror of an engine that lives somewhere else.
//
// Everything shown here is read the same way whether the engine runs in this
// tab or in a worker — that is the whole point of the page. The numbers on
// screen are the evidence: engine ticks climb only while a panel watches, and
// panel wakings show what actually crossed the wire.

import { useState } from 'react'
import type { ReactNode } from 'react'
import { useLive } from '#loom/react'
import type { Adopted } from '#loom'

interface Props {
  readonly engine: Adopted
  /** Raise a new worker, and tell it what this panel already knows. */
  readonly restart: (pattern: string) => void
}

/** One number, named. */
function Count({ label, value }: { label: string; value: number | string }): ReactNode {
  return (
    <span className="count">
      <b>{value}</b> {label}
    </span>
  )
}

/** A panel that watches the engine. Mounting it is demand; unmounting is not. */
function Matches({ engine }: { engine: Adopted }): ReactNode {
  const shown = useLive(() => engine.view<number>('matches').get())
  return (
    <p>
      matches: <b>{shown ?? '—'}</b>
    </p>
  )
}

/** A second watcher of the same work, drawn as bars. */
function Shape({ engine }: { engine: Adopted }): ReactNode {
  const bars = useLive(() => engine.view<readonly number[]>('shape').get()) ?? []
  const most = Math.max(1, ...bars)
  return (
    <div className="bars">
      {bars.map((value, at) => (
        <i
          // The index is the identity here: a bucket is its position, and the
          // tenth bucket stays the tenth however its count changes.
          key={`bucket-${String(at)}`}
          style={{ height: `${String(Math.round((value / most) * 100))}%` }}
          title={String(value)}
        />
      ))}
    </div>
  )
}

export function App({ engine, restart }: Props): ReactNode {
  const [watching, setWatching] = useState(true)
  const ticks = useLive(() => engine.view<number>('ticks').get())
  // Typed here, sent over the wire, echoed back when the engine has it. The
  // field shows what was typed rather than waiting for the echo: a round trip
  // is short, but it is not zero, and a field that lags a keystroke behind is
  // the oldest bug in remote state.
  const [typed, setTyped] = useState('')
  const echoed = useLive(() => engine.view<string>('needle').get())

  return (
    <main className="engine">
      <h1>An engine behind a wire</h1>
      <p className="story">
        The state module — corpus, pattern, the counting itself — lives on the other side of a
        worker. This panel holds nothing but mirrors. Close the panel and the engine stops working:
        no demand, no work. Kill the worker and the mirrors ask again by themselves, without a line
        of code here noticing.
      </p>

      <div className="row">
        <label>
          pattern{' '}
          <input
            value={typed}
            onChange={event => {
              setTyped(event.target.value)
              engine.write('needle', event.target.value)
            }}
            placeholder="try: alpha"
          />
        </label>
        <button type="button" onClick={() => setWatching(open => !open)}>
          {watching ? 'close the panel' : 'open the panel'}
        </button>
        <button type="button" onClick={() => restart(typed)}>
          kill the worker
        </button>
      </div>

      <div className="row numbers">
        <Count label="engine ticks" value={ticks ?? '—'} />
        <Count label="watching" value={watching ? 'yes' : 'no'} />
        <Count label="engine has" value={echoed === undefined ? '—' : `"${echoed}"`} />
      </div>

      {watching ? (
        <div className="panel">
          <Matches engine={engine} />
          <Shape engine={engine} />
        </div>
      ) : (
        <p className="dim">The panel is closed. The ticks above should stand still.</p>
      )}
    </main>
  )
}
