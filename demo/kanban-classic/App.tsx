// The classic side's screen wiring: selectors in, dispatches out.
// The board itself is the shared component.

import type { ReactNode } from 'react'
import { Provider, useDispatch, useSelector } from 'react-redux'
import { Loader2 } from 'lucide-react'
import { BoardView } from '#kanban/board.tsx'
import { Button } from '../kanban-common/ui/button.tsx'
import { boardLoad, cardAdd, cardDelete, cardMove } from './actions.ts'
import {
  selectAddBusy,
  selectBusyIds,
  selectCards,
  selectColumnViews,
  selectError,
  selectLoading,
  selectNotice,
} from './selectors.ts'
import { store } from './app.ts'

function Screen(): ReactNode {
  const dispatch = useDispatch()
  const columns = useSelector(selectColumnViews)
  const cards = useSelector(selectCards)
  const busy = useSelector(selectBusyIds)
  const addBusy = useSelector(selectAddBusy)
  const notice = useSelector(selectNotice)
  const loading = useSelector(selectLoading)
  const error = useSelector(selectError)

  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-2">
        <h1 className="text-base font-semibold">Kanban, classic</h1>
        <span className="text-xs text-muted-foreground">redux + redux-observable</span>
        {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        {notice !== null && <span className="text-xs text-red-600">{notice}</span>}
      </header>
      {error !== null ? (
        <div className="flex flex-col items-start gap-2 p-6">
          <p className="text-sm text-red-600">{error}</p>
          <Button size="sm" onClick={() => dispatch(boardLoad())}>
            Retry
          </Button>
        </div>
      ) : (
        <BoardView
          columns={columns}
          cardOf={id => cards[id]}
          pending={id => busy.has(id)}
          addBusy={addBusy}
          onMove={(id, toColumn, toIndex) => dispatch(cardMove(id, toColumn, toIndex))}
          onAdd={(column, title) => dispatch(cardAdd(column, title))}
          onDelete={id => dispatch(cardDelete(id))}
        />
      )}
    </main>
  )
}

export function App(): ReactNode {
  return (
    <Provider store={store}>
      <Screen />
    </Provider>
  )
}
