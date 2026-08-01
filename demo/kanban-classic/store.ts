// Wiring: store, epic middleware, the shared server, the bot.

import { applyMiddleware, combineReducers, legacy_createStore as createStore } from 'redux'
import { createEpicMiddleware } from 'redux-observable'
import type { KanbanServer } from '../kanban-common/server.ts'
import type { BoardAction } from './actions.ts'
import { makeEpics } from './epics.ts'
import type { RootState } from './epics.ts'
import { boardReducer } from './reducer.ts'

export function makeStore(server: KanbanServer, pollMs?: number) {
  const epicMiddleware = createEpicMiddleware<BoardAction, BoardAction, RootState>()
  const store = createStore(
    combineReducers({ board: boardReducer }),
    applyMiddleware(epicMiddleware),
  )
  epicMiddleware.run(makeEpics(server, pollMs))
  return store
}
