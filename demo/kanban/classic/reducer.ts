// One reducer for the board: normalized byId maps, per-column id lists,
// optimistic moves and deletes with hand-kept rollback bookkeeping.

import type { Card } from '#kanban'
import type { UnknownAction } from 'redux'
import * as A from './actions.ts'
import type { BoardAction } from './actions.ts'

export interface ColumnState {
  id: string
  title: string
  limit: number
  cardIds: string[]
}

export interface BoardState {
  loading: boolean
  error: string | null
  version: number
  columnOrder: string[]
  columns: Record<string, ColumnState>
  cards: Record<string, Card>
  /** Where a card stood before the move the server has not confirmed. */
  pendingMoves: Record<string, { column: string; index: number }>
  /** What we deleted and where, until the server agrees. */
  pendingDeletes: Record<string, { card: Card; column: string; index: number }>
  addBusy: string | null
  notice: string | null
}

export const initial: BoardState = {
  loading: false,
  error: null,
  version: 0,
  columnOrder: [],
  columns: {},
  cards: {},
  pendingMoves: {},
  pendingDeletes: {},
  addBusy: null,
  notice: null,
}

function findCard(state: BoardState, id: string): { column: string; index: number } | null {
  for (const columnId of state.columnOrder) {
    const column = state.columns[columnId]
    if (column === undefined) continue
    const index = column.cardIds.indexOf(id)
    if (index >= 0) return { column: columnId, index }
  }
  return null
}

function withoutCard(
  columns: Record<string, ColumnState>,
  id: string,
): Record<string, ColumnState> {
  const next: Record<string, ColumnState> = {}
  for (const key of Object.keys(columns)) {
    const column = columns[key]
    if (column === undefined) continue
    next[key] = column.cardIds.includes(id)
      ? { ...column, cardIds: column.cardIds.filter(c => c !== id) }
      : column
  }
  return next
}

function insertCard(
  columns: Record<string, ColumnState>,
  id: string,
  columnId: string,
  index: number,
): Record<string, ColumnState> {
  const column = columns[columnId]
  if (column === undefined) return columns
  const at = Math.max(0, Math.min(index, column.cardIds.length))
  const cardIds = [...column.cardIds.slice(0, at), id, ...column.cardIds.slice(at)]
  return { ...columns, [columnId]: { ...column, cardIds } }
}

function drop<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _dropped, ...rest } = record
  return rest
}

export function boardReducer(state: BoardState = initial, action: UnknownAction): BoardState {
  // Redux hands every reducer foreign actions too; the cast is the usual tax.
  const a = action as BoardAction
  switch (a.type) {
    case A.BOARD_LOAD:
      return a.silent ? state : { ...state, loading: true, error: null }

    case A.BOARD_LOAD_SUCCESS: {
      const columns: Record<string, ColumnState> = {}
      for (const column of a.snapshot.columns) columns[column.id] = { ...column }
      const cards: Record<string, Card> = {}
      for (const card of a.snapshot.cards) cards[card.id] = card
      return {
        ...state,
        loading: false,
        error: null,
        version: a.snapshot.version,
        columnOrder: a.snapshot.columns.map(c => c.id),
        columns,
        cards,
      }
    }

    case A.BOARD_LOAD_FAILURE:
      return { ...state, loading: false, error: a.error }

    case A.CARD_MOVE: {
      const was = findCard(state, a.id)
      if (was === null) return state
      const columns = insertCard(withoutCard(state.columns, a.id), a.id, a.toColumn, a.toIndex)
      // A second move while the first is in flight keeps the earliest origin:
      // that is where the card goes back to if the server refuses.
      const pendingMoves =
        state.pendingMoves[a.id] !== undefined
          ? state.pendingMoves
          : { ...state.pendingMoves, [a.id]: was }
      return { ...state, columns, pendingMoves }
    }

    case A.CARD_MOVE_SUCCESS:
      return { ...state, pendingMoves: drop(state.pendingMoves, a.id) }

    case A.CARD_MOVE_FAILURE: {
      const origin = state.pendingMoves[a.id]
      if (origin === undefined) return { ...state, notice: a.error }
      const columns = insertCard(
        withoutCard(state.columns, a.id),
        a.id,
        origin.column,
        origin.index,
      )
      return {
        ...state,
        columns,
        pendingMoves: drop(state.pendingMoves, a.id),
        notice: a.error,
      }
    }

    case A.CARD_ADD:
      return { ...state, addBusy: a.column }

    case A.CARD_ADD_SUCCESS: {
      const column = state.columns[a.column]
      if (column === undefined) return { ...state, addBusy: null }
      return {
        ...state,
        addBusy: null,
        cards: { ...state.cards, [a.card.id]: a.card },
        columns: {
          ...state.columns,
          [a.column]: { ...column, cardIds: [...column.cardIds, a.card.id] },
        },
      }
    }

    case A.CARD_ADD_FAILURE:
      return { ...state, addBusy: null, notice: a.error }

    case A.CARD_DELETE: {
      const was = findCard(state, a.id)
      const card = state.cards[a.id]
      if (was === null || card === undefined) return state
      return {
        ...state,
        columns: withoutCard(state.columns, a.id),
        cards: drop(state.cards, a.id),
        pendingDeletes: { ...state.pendingDeletes, [a.id]: { card, ...was } },
      }
    }

    case A.CARD_DELETE_SUCCESS:
      return { ...state, pendingDeletes: drop(state.pendingDeletes, a.id) }

    case A.CARD_DELETE_FAILURE: {
      const held = state.pendingDeletes[a.id]
      if (held === undefined) return { ...state, notice: a.error }
      return {
        ...state,
        cards: { ...state.cards, [a.id]: held.card },
        columns: insertCard(state.columns, a.id, held.column, held.index),
        pendingDeletes: drop(state.pendingDeletes, a.id),
        notice: a.error,
      }
    }

    case A.NOTICE_CLEAR:
      return state.notice === null ? state : { ...state, notice: null }

    default:
      return state
  }
}
