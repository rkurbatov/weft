// The effects: load, mutations with rollback actions, polling with a hand
// guard against clobbering optimistic state, and a notice that clears itself.

import { combineEpics, ofType } from 'redux-observable'
import type { Epic } from 'redux-observable'
import { from, of, timer } from 'rxjs'
import {
  catchError,
  delay,
  exhaustMap,
  filter,
  map,
  mergeMap,
  switchMap,
  takeUntil,
} from 'rxjs/operators'
import type { KanbanServer } from '../kanban-common/server.ts'
import * as A from './actions.ts'
import type { BoardAction } from './actions.ts'
import type { BoardState } from './reducer.ts'

export interface RootState {
  board: BoardState
}

type BoardEpic = Epic<BoardAction, BoardAction, RootState>

// Any failure leaves a notice; the notice wipes itself a moment later.
const noticeEpic: BoardEpic = action$ =>
  action$.pipe(
    ofType(A.CARD_MOVE_FAILURE, A.CARD_ADD_FAILURE, A.CARD_DELETE_FAILURE),
    switchMap(() => of(A.noticeClear()).pipe(delay(4000))),
  )

export function makeEpics(server: KanbanServer, pollMs = 4000): BoardEpic {
  const loadEpic: BoardEpic = action$ =>
    action$.pipe(
      ofType(A.BOARD_LOAD),
      switchMap(() =>
        from(server.board()).pipe(
          map(snapshot => A.boardLoadSuccess(snapshot)),
          catchError(error => of(A.boardLoadFailure(String(error)))),
        ),
      ),
    )

  const moveEpic: BoardEpic = action$ =>
    action$.pipe(
      ofType(A.CARD_MOVE),
      mergeMap(action => {
        const { id, toColumn, toIndex } = action as ReturnType<typeof A.cardMove>
        return from(server.moveCard(id, toColumn, toIndex)).pipe(
          map(() => A.cardMoveSuccess(id)),
          catchError(error => of(A.cardMoveFailure(id, String(error)))),
        )
      }),
    )

  const addEpic: BoardEpic = action$ =>
    action$.pipe(
      ofType(A.CARD_ADD),
      mergeMap(action => {
        const { column, title } = action as ReturnType<typeof A.cardAdd>
        return from(server.addCard(column, title, 'feature')).pipe(
          map(card => A.cardAddSuccess(column, card)),
          catchError(error => of(A.cardAddFailure(column, String(error)))),
        )
      }),
    )

  const deleteEpic: BoardEpic = action$ =>
    action$.pipe(
      ofType(A.CARD_DELETE),
      mergeMap(action => {
        const { id } = action as ReturnType<typeof A.cardDelete>
        return from(server.deleteCard(id)).pipe(
          map(() => A.cardDeleteSuccess(id)),
          catchError(error => of(A.cardDeleteFailure(id, String(error)))),
        )
      }),
    )

  // Polling: ask for the cheap version number, reload silently when it grew —
  // unless something optimistic is in flight, or the reload would clobber it.
  const pollEpic: BoardEpic = (action$, state$) =>
    timer(pollMs, pollMs).pipe(
      exhaustMap(() =>
        from(server.version()).pipe(
          filter(version => {
            const board = state$.value.board
            return (
              version > board.version &&
              Object.keys(board.pendingMoves).length === 0 &&
              Object.keys(board.pendingDeletes).length === 0 &&
              board.addBusy === null &&
              !board.loading
            )
          }),
          map(() => A.boardLoad(true)),
          catchError(() => of<BoardAction>()),
        ),
      ),
    )

  // Any failure leaves a notice; the notice wipes itself a moment later.
  const root = combineEpics(loadEpic, moveEpic, addEpic, deleteEpic, pollEpic, noticeEpic)
  // The usual teardown pattern: one action ends every effect (tests, hot reload).
  const stoppable: BoardEpic = (action$, state$, deps) =>
    root(action$, state$, deps).pipe(takeUntil(action$.pipe(ofType(A.APP_STOP))))
  return stoppable
}
