import { useMemo } from 'react'
import { Grid, Toolbar } from '../common/ui.tsx'
import { key, sampleSheet, shapeFromLocation, sizeOf } from '../common/sample.ts'
import { countGridRender, timeEdit } from '../common/stats.ts'
import { createSheet } from './sheet.ts'
import { cellOf } from './Cell.tsx'

export function App() {
  const shape = useMemo(() => shapeFromLocation(), [])
  const { sheet, built } = useMemo(() => {
    const started = performance.now()
    const made = createSheet(sampleSheet(shape))
    return { sheet: made, built: Math.round(performance.now() - started) }
  }, [shape])
  const Derived = useMemo(() => cellOf(sheet), [sheet])
  countGridRender()

  const actions = [
    {
      label: 'bump A1',
      run: () =>
        timeEdit('A1 + 1', () => {
          sheet.set('A1', String(Number(sheet.text('A1') || '0') + 1))
        }),
    },
    {
      label: 'bump 50 scattered cells',
      run: () =>
        timeEdit('50 cells in column A, as one settling', () => {
          const changes: Array<[string, string]> = []
          for (let i = 0; i < 50; i++) {
            const row = Math.floor((i * (shape.rows - 1)) / 50)
            const at = key(row, 0)
            changes.push([at, String(Number(sheet.text(at) || '0') + 1)])
          }
          sheet.edit(changes)
        }),
    },
    {
      label: 'make a loop in A1',
      run: () =>
        timeEdit('A1 = the last total (a loop)', () => {
          sheet.set('A1', `=A${shape.rows}`)
        }),
    },
  ]

  return (
    <>
      <Toolbar
        title="On weft — a cell is an input, a value is a formula"
        note={`${sizeOf(shape).toLocaleString()} cells laid out in ${built} ms, and only what is looked at is worked out. No dependency graph is written here, no order of recomputation, no invalidation, no loop search.`}
        actions={actions}
      />
      <Grid shape={shape} cell={Derived} />
    </>
  )
}
