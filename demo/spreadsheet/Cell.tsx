// The one component that differs between the demos: where a cell's value comes
// from. Here it is a subscription to the store, keyed by address.

import { memo } from 'react'
import { CellFrame } from '../common/ui.tsx'
import { countCellRender } from '../common/stats.ts'
import type { CellProps } from '../common/ui.tsx'
import { useSheet, useShown } from './useSheet.ts'

export const Cell = memo(function Cell({ at }: CellProps) {
  const sheet = useSheet()
  const shown = useShown(at)
  countCellRender()
  return <CellFrame shown={shown} text={sheet.text(at)} onCommit={text => sheet.set(at, text)} />
})
