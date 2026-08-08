// The presentation both demos share: the grid frame, the editing behaviour of a
// cell, the toolbar. What differs between the demos is who tells a cell its
// value — and that is exactly the component each one supplies itself.

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { columnName } from './address.ts'
import { SHEET, key } from './sample.ts'
import type { SheetShape } from './sample.ts'
import { useCounters, resetCounters } from '#demo'

export interface CellProps {
  readonly at: string
  readonly row: number
  readonly col: number
}

export interface GridProps {
  readonly shape?: SheetShape
  /** The demo's own cell: it decides where its value comes from. */
  readonly cell: (props: CellProps) => ReactNode
  /** Rows kept above and below the opening, so a fast scroll does not show gaps. */
  readonly overscan?: number
}

/** Must match .row and .cell in style.css: the whole thing rests on a fixed row height. */
const ROW = 25
const COLUMN = 92
const GUTTER = 46

/**
 * Only the rows in the opening exist. The scroller is given the full height of
 * the sheet so the bar behaves honestly, and the rows that are drawn sit at the
 * offset the scroll position asks for.
 */
export function Grid({ shape = SHEET, cell: CellOf, overscan = 12 }: GridProps): ReactNode {
  const viewport = useRef<HTMLDivElement>(null)
  const frame = useRef(0)
  // The state is the first row drawn, not the scroll position: a pixel of
  // scrolling is not news, a row of it is.
  const [first, setFirst] = useState(0)
  const [height, setHeight] = useState(600)

  useEffect(() => {
    const box = viewport.current
    if (box === null) return
    const measure = (): void => setHeight(box.clientHeight)
    measure()
    const watcher = new ResizeObserver(measure)
    watcher.observe(box)
    return () => {
      watcher.disconnect()
      if (frame.current !== 0) cancelAnimationFrame(frame.current)
    }
  }, [])

  // One redraw per frame at most, and only when the opening has actually moved.
  const onScroll = (): void => {
    if (frame.current !== 0) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const box = viewport.current
      if (box === null) return
      const wanted = Math.max(0, Math.floor(box.scrollTop / ROW) - overscan)
      setFirst(was => (was === wanted ? was : wanted))
    })
  }

  const drawn = Math.min(shape.rows - first, Math.ceil(height / ROW) + overscan * 2)
  const width = GUTTER + shape.cols * COLUMN

  return (
    <div className="grid-wrap">
      <div className="viewport" ref={viewport} onScroll={onScroll}>
        <div className="head" style={{ width }}>
          <div className="corner" />
          {Array.from({ length: shape.cols }, (_, col) => (
            <div className="colhead" key={col}>
              {columnName(col)}
            </div>
          ))}
        </div>
        <div className="sheet" style={{ height: shape.rows * ROW, width }}>
          <div className="rows" style={{ transform: `translateY(${first * ROW}px)` }}>
            {Array.from({ length: drawn }, (_, i) => {
              const row = first + i
              return (
                <div className="row" key={row}>
                  <div className="rowhead">{row + 1}</div>
                  {Array.from({ length: shape.cols }, (_slot, col) => (
                    <div className="slot" key={col}>
                      <CellOf at={key(row, col)} row={row} col={col} />
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      </div>
      <p className="where">
        rows {first + 1}–{first + drawn} of {shape.rows.toLocaleString()} — {drawn * shape.cols}{' '}
        cells drawn of {(shape.rows * shape.cols).toLocaleString()}
      </p>
    </div>
  )
}

export interface CellFrameProps {
  /** What the cell shows when it is not being edited. */
  readonly shown: string
  /** The text behind it, which is what the editor opens on. */
  readonly text: string
  readonly onCommit: (text: string) => void
  readonly title?: string
}

/** Click to edit, Enter or blur to commit, Escape to give up. Shared, so editing feels the same in both. */
export function CellFrame({ shown, text, onCommit, title }: CellFrameProps): ReactNode {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)
  const box = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) box.current?.select()
  }, [editing])

  if (!editing) {
    return (
      <button
        type="button"
        className="cell shown"
        title={title ?? text}
        onClick={() => {
          setDraft(text)
          setEditing(true)
        }}
      >
        {shown}
      </button>
    )
  }

  const commit = (): void => {
    setEditing(false)
    if (draft !== text) onCommit(draft)
  }

  return (
    <input
      ref={box}
      className="cell editing"
      value={draft}
      onChange={event => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={event => {
        if (event.key === 'Enter') commit()
        if (event.key === 'Escape') setEditing(false)
      }}
    />
  )
}

export interface ToolbarProps {
  readonly title: string
  readonly note: string
  readonly actions: ReadonlyArray<{ readonly label: string; readonly run: () => void }>
}

export function Toolbar({ title, note, actions }: ToolbarProps): ReactNode {
  const counters = useCounters()
  return (
    <header className="bar">
      <div className="who">
        <h1>{title}</h1>
        <p>{note}</p>
      </div>
      <div className="actions">
        {actions.map(action => (
          <button type="button" key={action.label} onClick={action.run}>
            {action.label}
          </button>
        ))}
        <button type="button" onClick={resetCounters}>
          reset counters
        </button>
      </div>
      <dl className="numbers">
        <div>
          <dt>last change</dt>
          <dd>{counters.lastEdit}</dd>
        </div>
        <div>
          <dt>settled in</dt>
          <dd>{counters.lastEditMs} ms</dd>
        </div>
        <div>
          <dt>cells re-rendered by it</dt>
          <dd>{counters.lastEditRenders}</dd>
        </div>
        <div>
          <dt>cell renders since reset</dt>
          <dd>{counters.cellRenders}</dd>
        </div>
        <div>
          <dt>whole-grid renders</dt>
          <dd>{counters.gridRenders}</dd>
        </div>
      </dl>
    </header>
  )
}
