// The weft side's screen wiring: cells in, calls out. The look itself is the
// demand: the source loads and polls while this screen is mounted, and rests
// when it is not. The board is the shared component.

import type { ReactNode } from 'react'
import { Loader2, WifiOff } from 'lucide-react'
import { useCell } from '#weft/react'
import { BoardView } from '../kanban-common/board.tsx'
import { Button } from '../kanban-common/ui/button.tsx'
import type { Kanban } from './state.ts'

function Screen({ app }: { app: Kanban }): ReactNode {
  const columns = useCell(app.state.layout)
  const cards = useCell(app.state.cards)
  const busy = useCell(app.state.busy)
  const addBusy = useCell(app.state.addBusy)
  const notice = useCell(app.state.notice)
  const coldStart = useCell(app.state.coldStart)
  const fault = useCell(app.state.fault)
  const owed = useCell(app.post.owed)

  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-2">
        <h1 className="text-base font-semibold">Kanban, weft</h1>
        <span className="text-xs text-muted-foreground">base + overlay</span>
        {coldStart && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        {owed > 0 && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <WifiOff className="size-3" /> owed {owed}
          </span>
        )}
        {notice !== null && <span className="text-xs text-red-600">{notice}</span>}
      </header>
      {fault !== null ? (
        <div className="flex flex-col items-start gap-2 p-6">
          <p className="text-sm text-red-600">{fault}</p>
          <Button size="sm" onClick={() => void app.actions.load()}>
            Retry
          </Button>
        </div>
      ) : (
        <BoardView
          columns={columns}
          cardOf={id => cards.get(id)}
          pending={id => busy.has(id)}
          addBusy={addBusy}
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
