// The root is the assembler: it raises the server, wires the ports into the
// state inside one region, and hands the result to the screen. Nothing here
// runs at import time of anything — the composition is a place, not a side
// effect.

import { mount } from '#demo/mount.tsx'
import { region } from '#loom'
import '#kanban/kanban.css'
import { kanbanServer } from '#kanban'
import { kanban } from './state.ts'
import { App } from './App.tsx'

const server = kanbanServer()
const board = region('kanban', () => kanban(server))
server.startBot()

mount(<App app={board.value} />)
