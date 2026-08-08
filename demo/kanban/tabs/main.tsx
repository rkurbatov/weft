// The carried kanban: open this page in several tabs. One of them leads — it
// builds the station and serves everybody over the bus; the rest are mirrors.
// Close the leader and watch the lock hand the station to the next tab: the
// book survives the succession, the screens never learn who carries them.

import type { ReactNode } from 'react'
import { mount } from '#demo/mount.tsx'
import { perFrame } from '#weft'
import { carry } from '#loom'
import { useLive } from '#loom/react'
import '#kanban/kanban.css'
import { kanbanServer } from '#kanban'
import { kanban } from '../weft/state.ts'
import { kanbanMirror, serveKanban } from '../weft/mirror.ts'
import { App } from '../weft/App.tsx'

const carried = carry({
  name: 'weft-kanban-tabs',
  station: () => {
    // The server pretends to be the world; each leader gets its own copy, the
    // way each backend deployment would. The book travels by succession.
    const server = kanbanServer({ latency: 120, grumpiness: 0.15 })
    const app = kanban(server, 4000)
    console.log('[carried] the book lives on:', app.post.shelf)
    return {
      serve: channel => serveKanban(app, channel, { schedule: perFrame, instruments: true }),
      dispose: app.dispose,
    }
  },
})

const tab = kanbanMirror(carried.channel)

// Breadcrumbs for the browser console: which build runs, who leads, what the
// mirrors hold — read directly, past React, so a frozen screen cannot lie.
console.log('[carried] page v3')
import('#weft').then(({ subscribe }) => {
  console.log('[carried] role:', carried.role.peek())
  subscribe(carried.role, () => console.log('[carried] role:', carried.role.peek()))
  const stop = subscribe(tab.state.layout, () => {
    if (tab.state.layout.peek().length > 0) {
      console.log('[carried] board arrived:', tab.state.layout.peek().length, 'columns')
      stop()
    }
  })
})
setInterval(() => {
  console.log(
    '[carried] pulse',
    'role',
    carried.role.peek(),
    'cold',
    tab.state.coldStart.peek(),
    'columns',
    tab.state.layout.peek().length,
    'cards',
    tab.state.cards.peek().size,
  )
}, 2000)

// Vite dev: a hot-replaced module must let go of the carrier, or its still
// held lock leaves a zombie leader and every next instance follows a corpse.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    tab.dispose()
    carried.stop()
  })
}

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

mount(<Carried />)
