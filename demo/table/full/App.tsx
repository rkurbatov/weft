// Following a whole table over a wire that can lose batches.
//
// What a visitor should be able to tell without reading code: rows keep
// arriving and changing while nobody touches the page; flipping the switch
// makes the wire drop batches and the rows stop moving — labelled, not
// silently stale; flipping it back brings everything into line again, and the
// count of catch-ups says how it was done.

import type { ReactNode } from 'react'
import { useLive } from '#loom/react'
import { desk } from './main.tsx'
import type { Job } from './state.ts'

function Count({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className="count">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  )
}

export function App(): ReactNode {
  const station = desk.get()
  const size = useLive(() => station.size.get()) ?? 0
  const poured = useLive(() => station.poured.get()) ?? 0
  const edited = useLive(() => station.edited.get()) ?? 0
  const recomputed = useLive(() => station.recomputed.get())
  const woken = useLive(() => station.woken.get())
  const rows = useLive(() => station.jobs.rows.get())
  const received = useLive(() => station.jobs.received.get())
  const cold = useLive(() => station.jobs.cold.get())
  const catchingUp = useLive(() => station.jobs.catchingUp.get())
  const caughtUp = useLive(() => station.jobs.caughtUp.get()) ?? 0
  const losing = useLive(() => station.losing.get())

  const shown = rows.slice(-25) as Job[]

  return (
    <main className="desk">
      <h1>A whole table, followed over a wire</h1>
      <p className="story">
        A worker holds this table and keeps working on it: rows arrive, rows change state. This page
        follows the whole thing — one snapshot, then batches of what changed. The other table page
        shows a window instead; here the point is the protocol underneath.
      </p>

      <div className="counts">
        <Count label="rows in the table" value={size.toLocaleString('en')} />
        <Count label="rows poured in" value={poured.toLocaleString('en')} />
        <Count label="rows edited in place" value={edited.toLocaleString('en')} />
        <Count label="rows and changes received" value={(received ?? 0).toLocaleString('en')} />
        <Count label="catch-ups" value={caughtUp.toLocaleString('en')} />
        <Count label="formulas recomputed there" value={recomputed?.toLocaleString('en') ?? '—'} />
        <Count label="watchers woken there" value={woken?.toLocaleString('en') ?? '—'} />
      </div>

      <div className="controls">
        <button
          type="button"
          className={losing === true ? 'on' : ''}
          onClick={() => station.losing.set(losing !== true)}
        >
          {losing === true ? 'stop losing batches' : 'lose batches'}
        </button>
        <button type="button" onClick={() => void station.pour(500)}>
          pour 500 rows
        </button>
        <button type="button" onClick={() => void station.touch(200)}>
          edit 200 rows
        </button>
        <span className={catchingUp === true ? 'state catching' : 'state'}>
          {cold === true
            ? 'nothing has arrived yet'
            : catchingUp === true
              ? 'a batch was lost — showing the last good rows while catching up'
              : 'up to date'}
        </span>
      </div>

      <ol className="jobs">
        {shown.map(job => (
          <li key={job.id} className={job.state}>
            <span className="no">{job.id}</span>
            {job.title}
            <span className="state-name">{job.state}</span>
          </li>
        ))}
      </ol>

      <p className="story small">
        The switch drops batches of changes before they reach this side — snapshots are let through,
        or there would be nothing to lose. When a batch goes missing, the next one does not fit onto
        what this side holds, and applying it would quietly corrupt the rows. So it is not applied:
        the last good rows stay on screen, labelled, and a catch-up is asked for. A follower that
        has fallen behind further than the table remembers is sent the whole thing again rather than
        a lie about continuity.
      </p>
    </main>
  )
}
