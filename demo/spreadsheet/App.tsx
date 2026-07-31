import { useMemo } from 'react'
import { Grid, Toolbar } from '../common/ui.tsx'
import { key, sampleSheet, shapeFromLocation, sizeOf } from '../common/sample.ts'
import { countGridRender, timeEdit } from '../common/stats.ts'
import { createSheet } from './store.ts'
import { SheetProvider } from './useSheet.ts'
import { Cell } from './Cell.tsx'

export function App() {
  const shape = useMemo(() => shapeFromLocation(), [])
  const { sheet, built } = useMemo(() => {
    const started = performance.now()
    const made = createSheet(sampleSheet(shape))
    return { sheet: made, built: Math.round(performance.now() - started) }
  }, [shape])
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
        timeEdit('50 cells in column A', () => {
          for (let i = 0; i < 50; i++) {
            const row = Math.floor((i * (shape.rows - 1)) / 50)
            const at = key(row, 0)
            sheet.set(at, String(Number(sheet.text(at) || '0') + 1))
          }
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
    <SheetProvider value={sheet}>
      <Toolbar
        title="Classic — state by hand"
        note={`${sizeOf(shape).toLocaleString()} cells worked out at startup in ${built} ms. A store of texts, a dependency graph kept both ways, a topological order for recomputation, loop detection, and a subscription per cell.`}
        actions={actions}
      />
      <Grid shape={shape} cell={Cell} />
    </SheetProvider>
  )
}
