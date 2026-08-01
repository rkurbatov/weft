// The running app: one server, one state, the bot. Nobody calls load — the
// first look demands the source, and the source does the rest.

import { kanbanServer } from '../kanban-common/server.ts'
import { kanban } from './state.ts'

export const server = kanbanServer()
export const app = kanban(server)
server.startBot()
