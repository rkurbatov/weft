// The weft side's screen wiring: cells in, calls out.
// The board itself is the shared component.

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { useCell } from '#weft/react'
import { BoardView } from '../kanban-common/board.tsx'
import { Button } from '../kanban-common/ui/button.tsx'
import { app } from './app.ts'

function Screen(): ReactNode {
  const columns = useCell(app.layout)
  const all = useCell(app.cards.all)
  const writes = useCell(app.writes)
  const addBusy = useCell(app.addBusy)
  const notice = useCell(app.notice)
  const loading = useCell(app.loading)
  const error = useCell(app.error)

  const byId = useMemo(() => new Map(all.map(card => [card.id, card])), [all])

  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-2">
        <h1 className="text-base font-semibold">Kanban, weft</h1>
        <span className="text-xs text-muted-foreground">tables + cells</span>
        {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        {notice !== null && <span className="text-xs text-red-600">{notice}</span>}
      </header>
      {error !== null ? (
        <div className="flex flex-col items-start gap-2 p-6">
          <p className="text-sm text-red-600">{error}</p>
          <Button size="sm" onClick={() => void app.load(true)}>
            Retry
          </Button>
        </div>
      ) : (
        <BoardView
          columns={columns}
          cardOf={id => byId.get(id)}
          pending={id => writes.has(id)}
          addBusy={addBusy}
          onMove={(id, toColumn, toIndex) => void app.move(id, toColumn, toIndex)}
          onAdd={(column, title) => void app.add(column, title)}
          onDelete={id => void app.remove(id)}
        />
      )}
    </main>
  )
}

export function App(): ReactNode {
  return <Screen />
}
