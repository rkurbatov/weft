// The presentation both demos share: the grid frame, the editing behaviour of a
// cell, the toolbar. What differs between the demos is who tells a cell its
// value — and that is exactly the component each one supplies itself.

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { columnName } from './address.ts'
import { SHEET, key } from './sheet.ts'
import type { SheetShape } from './sheet.ts'
import { useCounters, resetCounters } from './stats.ts'

export interface CellProps {
    readonly at: string
    readonly row: number
    readonly col: number
}

export interface GridProps {
    readonly shape?: SheetShape
    /** The demo's own cell: it decides where its value comes from. */
    readonly cell: (props: CellProps) => ReactNode
    /** Rows drawn at once; the rest scroll into view. */
    readonly window?: number
}

export function Grid({ shape = SHEET, cell: CellOf, window = 30 }: GridProps): ReactNode {
    const [from, setFrom] = useState(0)
    const rows = Math.min(window, shape.rows - from)

    return (
        <div className="grid-wrap">
            <div className="grid-scroller">
                <button type="button" onClick={() => setFrom(Math.max(0, from - window))} disabled={from === 0}>
                    ↑ earlier rows
                </button>
                <span>
          rows {from + 1}–{from + rows} of {shape.rows}
        </span>
                <button
                    type="button"
                    onClick={() => setFrom(Math.min(shape.rows - 1, from + window))}
                    disabled={from + window >= shape.rows}
                >
                    later rows ↓
                </button>
            </div>
            <table className="grid">
                <thead>
                <tr>
                    <th className="corner" />
                    {Array.from({ length: shape.cols }, (_, col) => (
                        <th key={col}>{columnName(col)}</th>
                    ))}
                </tr>
                </thead>
                <tbody>
                {Array.from({ length: rows }, (_, i) => {
                    const row = from + i
                    return (
                        <tr key={row}>
                            <th className="rowhead">{row + 1}</th>
                            {Array.from({ length: shape.cols }, (_, col) => (
                                <td key={col}>
                                    <CellOf at={key(row, col)} row={row} col={col} />
                                </td>
                            ))}
                        </tr>
                    )
                })}
                </tbody>
            </table>
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