// A hundred thousand rows on the other side of a wire, twenty of them here.
//
// What a visitor should be able to tell without reading code: scrolling is
// smooth although the table is not on this thread; the counter of rows that
// crossed grows by a screenful, not by a table; and an edit half-typed
// survives its row scrolling out of sight and back.

import { useRef } from 'react'
import type { ReactNode } from 'react'
import { useLive } from '#loom/react'
import { desk } from './main.tsx'
import type { Task } from './state.ts'

const ROW = 28

function Count({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className="count">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  )
}

/** One row, with its draft kept outside the row itself. */
function Row({ task }: { task: Task }): ReactNode {
  const station = desk.get()
  const draft = useLive(() => station.draft(task.id).get())
  const editing = draft !== ''

  return (
    <div className="row" style={{ height: ROW }}>
      <span className="no">{task.id}</span>
      {editing ? (
        <input
          value={draft}
          autoFocus
          onChange={event => station.draft(task.id).set(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              void station.rename(task.id, draft)
              station.draft(task.id).set('')
            }
            if (event.key === 'Escape') station.draft(task.id).set('')
          }}
        />
      ) : (
        <button
          type="button"
          className="title"
          onClick={() => station.draft(task.id).set(task.title)}
        >
          {task.title}
        </button>
      )}
      <span className="owner">{task.owner}</span>
    </div>
  )
}

export function App(): ReactNode {
  const station = desk.get()
  const size = useLive(() => station.size.get()) ?? 0
  const from = useLive(() => station.from.get()) ?? 0
  const span = useLive(() => station.span.get()) ?? 20
  const rows = useLive(() => station.window.rows.get())
  const received = useLive(() => station.received.get()) ?? 0
  const scroller = useRef<HTMLDivElement>(null)

  return (
    <main className="desk">
      <h1>A table that lives in another thread</h1>
      <p className="story">
        A hundred thousand rows are held by a worker. This page shows twenty of them: scrolling
        writes the first visible row, and the worker answers with exactly the rows that fit. Click a
        title to edit it — then scroll it out of sight and back, and the half-typed text is still
        there.
      </p>

      <div className="counts">
        <Count label="rows in the table" value={size.toLocaleString('en')} />
        <Count label="rows on screen" value={rows.length} />
        <Count label="rows that crossed the wire" value={received.toLocaleString('en')} />
        <Count label="rows a whole-table mirror would send" value={size.toLocaleString('en')} />
      </div>

      <div
        className="scroller"
        ref={scroller}
        onScroll={event => {
          const view = event.target as HTMLDivElement
          station.from.set(Math.max(0, Math.floor(view.scrollTop / ROW)))
          // How many rows fit is the panel's business, and it changes with the
          // window: the desk hands out exactly this many and no more.
          const fits = Math.ceil(view.clientHeight / ROW) + 1
          if (fits !== span) station.span.set(fits)
        }}
      >
        <div className="tall" style={{ height: size * ROW }}>
          <div className="window" style={{ transform: `translateY(${String(from * ROW)}px)` }}>
            {rows.map(task => (
              <Row key={task.id} task={task} />
            ))}
          </div>
        </div>
      </div>

      <p className="story small">
        The window is a cell on the worker's side: the panel writes where it starts and how many
        rows fit, and reads back exactly those. Nothing else crosses — the counter above grows by a
        screenful per scroll, not by a table. The draft of an edit is a cell of its own, keyed by
        the row, which is why it outlives the row leaving the window: kept inside the row it would
        have gone with it.
      </p>
    </main>
  )
}
