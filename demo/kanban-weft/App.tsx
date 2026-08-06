// The screen is the last formula of the graph: one useLive reads what this
// screen needs, tracking does the rest. The board itself is the shared
// component.

import type { ReactNode } from 'react'
import { Loader2, WifiOff } from 'lucide-react'
import { useLive } from '#loom/react'
import { BoardView } from '#kanban/board.tsx'
import { Button } from '../kanban-common/ui/button.tsx'
import type { Kanban } from './state.ts'

function Screen({ app }: { app: Kanban }): ReactNode {
  const live = useLive(() => ({
    columns: app.state.layout.get(),
    cards: app.state.cards.get(),
    busy: app.state.busy.get(),
    addBusy: app.state.addBusy.get(),
    refused: app.state.refused.get(),
    coldStart: app.state.coldStart.get(),
    fault: app.state.fault.get(),
    owed: app.post.owed.get(),
  }))

  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-2">
        <h1 className="text-base font-semibold">Kanban, weft</h1>
        <span className="text-xs text-muted-foreground">spoken in the dialect</span>
        {live.coldStart && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        {live.owed > 0 && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <WifiOff className="size-3" /> owed {live.owed}
          </span>
        )}
        {live.refused !== null && (
          <span className="text-xs text-red-600">{live.refused.error}</span>
        )}
      </header>
      {live.fault !== null ? (
        <div className="flex flex-col items-start gap-2 p-6">
          <p className="text-sm text-red-600">{live.fault}</p>
          <Button size="sm" onClick={() => void app.actions.load()}>
            Retry
          </Button>
        </div>
      ) : (
        <BoardView
          columns={live.columns}
          cardOf={id => live.cards.get(id)}
          pending={id => live.busy.has(id)}
          addBusy={live.addBusy}
          onMove={(id, into, at) => void app.actions.move(id, into, at)}
          onAdd={(into, title) => void app.actions.add(into, title)}
          onDelete={id => void app.actions.remove(id)}
        />
      )}
    </main>
  )
}

export function App({ app }: { app: Kanban }): ReactNode {
  return <Screen app={app} />
}
