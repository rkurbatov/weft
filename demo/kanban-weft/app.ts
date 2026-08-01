// The running app: one server, one state, the bot, the first load.

import { kanbanServer } from '../kanban-common/server.ts'
import { kanban } from './state.ts'

export const server = kanbanServer()
export const app = kanban(server)
server.startBot()
void app.load(true)
