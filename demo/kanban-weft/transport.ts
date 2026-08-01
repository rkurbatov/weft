// The transport edge: the only module that sees the server. It declares the
// ports — a source for the board's truth, an outbox for what we owe the world,
// a call for creating cards — and hands them over as values. The state module
// receives ports and could not name the server if it wanted to.

import { memoryStore, outbox, source } from '#weft'
import type { Outbox, Source } from '#weft'
import type { BoardSnapshot, Card } from '../kanban-common/types.ts'
import type { KanbanServer } from '../kanban-common/server.ts'

/** The board with the moment its question was asked: absorption of settled
 *  entries downstream is judged against that, conservatively. */
export interface Base {
  snapshot: BoardSnapshot
  askedAt: number
}

export interface KanbanPorts {
  board: Source<Base>
  post: Outbox
  create(into: string, title: string): Promise<Card>
}

export function kanbanPorts(server: KanbanServer, pollMs = 4000): KanbanPorts {
  // A cheap version probe keeps an unchanged board from travelling again.
  let held: Base | undefined
  const board = source<Base>(
    async () => {
      const askedAt = Date.now()
      const version = await server.version()
      held =
        held === undefined || held.snapshot.version !== version
          ? { snapshot: await server.board(), askedAt }
          : { snapshot: held.snapshot, askedAt }
      return held
    },
    { name: 'board', every: pollMs },
  )

  const post = outbox({
    key: 'kanban',
    store: memoryStore(),
    handlers: {
      move: raw => {
        const op = raw as { id: string; into: string; at: number }
        return server.moveCard(op.id, op.into, op.at)
      },
      drop: raw => server.deleteCard((raw as { id: string }).id),
    },
    // The server's "conflict" is the world meaningfully saying no: rejected,
    // discarded at once, with a trace. Anything else would be transient.
    classify: error =>
      error instanceof Error && error.message.includes('conflict') ? 'rejected' : 'transient',
  })

  return { board, post, create: (into, title) => server.addCard(into, title, 'feature') }
}
