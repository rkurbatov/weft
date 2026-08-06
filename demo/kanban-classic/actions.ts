// Action constants and creators, the usual way.

import type { BoardSnapshot, Card } from '#kanban'

export const BOARD_LOAD = 'board/LOAD'
export const BOARD_LOAD_SUCCESS = 'board/LOAD_SUCCESS'
export const BOARD_LOAD_FAILURE = 'board/LOAD_FAILURE'
export const CARD_MOVE = 'card/MOVE'
export const CARD_MOVE_SUCCESS = 'card/MOVE_SUCCESS'
export const CARD_MOVE_FAILURE = 'card/MOVE_FAILURE'
export const CARD_ADD = 'card/ADD'
export const CARD_ADD_SUCCESS = 'card/ADD_SUCCESS'
export const CARD_ADD_FAILURE = 'card/ADD_FAILURE'
export const CARD_DELETE = 'card/DELETE'
export const CARD_DELETE_SUCCESS = 'card/DELETE_SUCCESS'
export const CARD_DELETE_FAILURE = 'card/DELETE_FAILURE'
export const NOTICE_CLEAR = 'notice/CLEAR'
export const APP_STOP = 'app/STOP'

export const boardLoad = (silent = false) => ({ type: BOARD_LOAD, silent }) as const
export const boardLoadSuccess = (snapshot: BoardSnapshot) =>
  ({ type: BOARD_LOAD_SUCCESS, snapshot }) as const
export const boardLoadFailure = (error: string) => ({ type: BOARD_LOAD_FAILURE, error }) as const

export const cardMove = (id: string, toColumn: string, toIndex: number) =>
  ({ type: CARD_MOVE, id, toColumn, toIndex }) as const
export const cardMoveSuccess = (id: string) => ({ type: CARD_MOVE_SUCCESS, id }) as const
export const cardMoveFailure = (id: string, error: string) =>
  ({ type: CARD_MOVE_FAILURE, id, error }) as const

export const cardAdd = (column: string, title: string) =>
  ({ type: CARD_ADD, column, title }) as const
export const cardAddSuccess = (column: string, card: Card) =>
  ({ type: CARD_ADD_SUCCESS, column, card }) as const
export const cardAddFailure = (column: string, error: string) =>
  ({ type: CARD_ADD_FAILURE, column, error }) as const

export const cardDelete = (id: string) => ({ type: CARD_DELETE, id }) as const
export const cardDeleteSuccess = (id: string) => ({ type: CARD_DELETE_SUCCESS, id }) as const
export const cardDeleteFailure = (id: string, error: string) =>
  ({ type: CARD_DELETE_FAILURE, id, error }) as const

export const noticeClear = () => ({ type: NOTICE_CLEAR }) as const
export const appStop = () => ({ type: APP_STOP }) as const

export type BoardAction =
  | ReturnType<typeof boardLoad>
  | ReturnType<typeof boardLoadSuccess>
  | ReturnType<typeof boardLoadFailure>
  | ReturnType<typeof cardMove>
  | ReturnType<typeof cardMoveSuccess>
  | ReturnType<typeof cardMoveFailure>
  | ReturnType<typeof cardAdd>
  | ReturnType<typeof cardAddSuccess>
  | ReturnType<typeof cardAddFailure>
  | ReturnType<typeof cardDelete>
  | ReturnType<typeof cardDeleteSuccess>
  | ReturnType<typeof cardDeleteFailure>
  | ReturnType<typeof noticeClear>
  | ReturnType<typeof appStop>
