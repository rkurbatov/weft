// The root is the assembler: it raises the server, wires the ports into the
// state inside one region, and hands the result to the screen. Nothing here
// runs at import time of anything — the composition is a place, not a side
// effect.

import { mount } from '#demo/mount.tsx'
import { region, underOwner } from '#loom'
import '#kanban/kanban.css'
import { kanbanServer } from '#kanban'
import { kanban } from './state.ts'
import { App } from './App.tsx'

const server = kanbanServer()
// Who is signed in, said once for everything this raises. The demo has one
// person; a real screen puts the signed-in one here. Without it the book of
// unsent moves would refuse to open on disk, and say so.
const board = underOwner({ app: 'kanban', session: 'demo' }, () =>
  region('kanban', () => kanban(server)),
)
server.startBot()

mount(<App app={board.value} />)
