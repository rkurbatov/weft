// The running app: one server, one store, the bot, the first load.

import { kanbanServer } from '../kanban-common/server.ts'
import { boardLoad } from './actions.ts'
import { makeStore } from './store.ts'

export const server = kanbanServer()
export const store = makeStore(server)
server.startBot()
store.dispatch(boardLoad())
