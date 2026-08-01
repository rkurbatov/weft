// Selectors: memoized where reference stability matters for the tree.

import { createSelector } from 'reselect'
import type { BoardColumnView } from '../kanban-common/board.tsx'
import type { RootState } from './epics.ts'

const selectColumns = (state: RootState) => state.board.columns
const selectColumnOrder = (state: RootState) => state.board.columnOrder

export const selectColumnViews = createSelector(
  [selectColumnOrder, selectColumns],
  (order, columns): BoardColumnView[] => {
    const views: BoardColumnView[] = []
    for (const id of order) {
      const column = columns[id]
      if (column !== undefined) views.push(column)
    }
    return views
  },
)

export const selectCards = (state: RootState) => state.board.cards

export const selectBusyIds = createSelector(
  [
    (state: RootState) => state.board.pendingMoves,
    (state: RootState) => state.board.pendingDeletes,
  ],
  (moves, deletes) => new Set([...Object.keys(moves), ...Object.keys(deletes)]),
)

export const selectNotice = (state: RootState) => state.board.notice
export const selectLoading = (state: RootState) => state.board.loading
export const selectError = (state: RootState) => state.board.error
export const selectAddBusy = (state: RootState) => state.board.addBusy
