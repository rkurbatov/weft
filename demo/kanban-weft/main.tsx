// The root is the assembler: it raises the server, wires the ports into the
// state inside one region, and hands the result to the screen. Nothing here
// runs at import time of anything — the composition is a place, not a side
// effect.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { region } from '#loom'
import '../kanban-common/kanban.css'
import { kanbanServer } from '../kanban-common/server.ts'
import { kanban } from './state.ts'
import { App } from './App.tsx'

const server = kanbanServer()
const board = region('kanban', () => kanban(server))
server.startBot()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App app={board.value} />
  </StrictMode>,
)
