// The one component that differs between the demos. Here a cell reads its own
// shown value straight from the graph — no context, no store, no subscription
// bookkeeping.

import { memo } from 'react'
import { useCell } from '#weft/react'
import { CellFrame } from '../common/ui.tsx'
import { countCellRender } from '../common/stats.ts'
import type { CellProps } from '../common/ui.tsx'
import type { Sheet } from './sheet.ts'

export function cellOf(sheet: Sheet) {
  return memo(function Cell({ at }: CellProps) {
    const shown = useCell(sheet.shown(at))
    countCellRender()
    return <CellFrame shown={shown} text={sheet.text(at)} onCommit={text => sheet.set(at, text)} />
  })
}
