// The carried kanban: open this page in several tabs. One of them leads — it
// builds the station and serves everybody over the bus; the rest are mirrors.
// Close the leader and watch the lock hand the station to the next tab: the
// book survives the succession, the screens never learn who carries them.

import { StrictMode } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { perFrame } from '#weft'
import { carry } from '#loom'
import { useLive } from '#loom/react'
import '../kanban-common/kanban.css'
import { kanbanServer } from '../kanban-common/server.ts'
import { kanban } from '../kanban-weft/state.ts'
import { kanbanMirror, serveKanban } from '../kanban-weft/mirror.ts'
import { App } from '../kanban-weft/App.tsx'

const carried = carry({
  name: 'weft-kanban-tabs',
  station: () => {
    // The server pretends to be the world; each leader gets its own copy, the
    // way each backend deployment would. The book travels by succession.
    const server = kanbanServer({ latency: 120, grumpiness: 0.15 })
    const app = kanban(server, 4000)
    return {
      serve: channel => serveKanban(app, channel, { schedule: perFrame, instruments: true }),
      dispose: app.dispose,
    }
  },
})

const tab = kanbanMirror(carried.channel)

function Carried(): ReactNode {
  const role = useLive(() => carried.role.get())
  return (
    <div>
      <p style={{ margin: 0, padding: '4px 16px', fontSize: 12, color: '#666' }}>
        this tab is <b>{role}</b> — open more tabs, close the leader, nothing is lost
      </p>
      <App app={tab} />
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Carried />
  </StrictMode>,
)
