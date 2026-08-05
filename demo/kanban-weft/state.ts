// The kanban, spoken in the dialect: three doors and two formulas. What the
// board is, what we say to the world, how a note looks on the picture — and
// nothing else. Queues, retries, retreat, absorption, identity, the key of a
// repeat: under the floor.

import { laid, cell, notes, sends, truth, will } from '#loom'
import type { Refusal, Truth } from '#loom'
import type { BoardSnapshot, Card, ColumnData } from '../kanban-common/types.ts'
import type { KanbanServer } from '../kanban-common/server.ts'
import type { Watchable } from '#weft'

type Move = { id: string; into: string; at: number }
type Drop = { id: string }
type Add = { into: string; title: string }
type Added = { card: Card; into: string }

export interface Kanban {
  state: {
    layout: Watchable<ColumnData[]>
    cards: Watchable<ReadonlyMap<string, Card>>
    busy: Watchable<ReadonlySet<string>>
    addBusy: Watchable<string | null>
    refused: Watchable<Refusal | null>
    coldStart: Watchable<boolean>
    fault: Watchable<string | null>
  }
  actions: {
    move(id: string, into: string, at: number): Promise<void>
    remove(id: string): Promise<void>
    add(into: string, title: string, key?: string): Promise<void>
    load(): Promise<void>
  }
  // `shelf` is the station's own fact: a mirror never holds the book.
  post: {
    pause(): void
    resume(): void
    owed: Watchable<number>
    shelf?: 'disk' | 'memory' | 'given'
  }
  dispose(): void
}

export function kanban(io: KanbanServer, pollMs = 4000): Kanban {
  const board: Truth<BoardSnapshot> = truth(() => io.board(), {
    name: 'board',
    poll: pollMs,
    empty: { columns: [], cards: [], version: 0 },
  })

  const post = will(
    {
      move: sends<Move>(op => io.moveCard(op.id, op.into, op.at)),
      drop: sends<Drop>(op => io.deleteCard(op.id)),
      // The key of the note rides to the server: a lost reply retried under
      // the same key answers with the very same card, never a second one.
      add: sends<Add>(async (op, key) => {
        const card = await io.addCard(op.into, op.title, 'feature', key)
        post.added({ card, into: op.into })
      }),
      added: notes<Added>(),
    },
    {
      name: 'kanban',
      judge: error =>
        error instanceof Error && error.message.includes('conflict') ? 'rejected' : 'transient',
      retry: 30,
    },
  )
  const seen = laid(board, post, {
    name: 'seen',
    shape: {
      rows: (s: BoardSnapshot) => s.cards,
      key: (c: Card) => c.id,
      lanes: (s: BoardSnapshot) => s.columns.map(({ id, cardIds }) => ({ id, items: cardIds })),
    },
    rules: {
      move: (b, op: Move) => b.place(op.id, op.into, op.at),
      drop: (b, op: Drop) => b.take(op.id),
      added: (b, op: Added) => b.put(op.card).place(op.card.id, op.into, 'end'),
    },
  })

  const layout = cell<ColumnData[]>(
    () => {
      const lanes = new Map(seen.get().lanes.map(lane => [lane.id, lane.items]))
      return board.get().columns.map(({ id, title, limit }) => ({
        id,
        title,
        limit,
        cardIds: [...(lanes.get(id) ?? [])],
      }))
    },
    { name: 'layout' },
  )

  return {
    state: {
      layout,
      cards: cell(() => seen.get().rows, { name: 'cards' }),
      busy: post.pending((kind, op) =>
        kind === 'move' || kind === 'drop' ? (op as Move | Drop).id : undefined,
      ),
      addBusy: cell(
        () => {
          for (const note of post.notes.get()) {
            if (note.name === 'add' && note.state !== 'done') return (note.args as Add).into
          }
          return null
        },
        { name: 'addBusy' },
      ),
      refused: post.refused,
      coldStart: cell(() => board.get().version === 0 && board.flight.get(), { name: 'coldStart' }),
      fault: cell(() => (board.get().version === 0 ? board.fault.get() : null), { name: 'fault' }),
    },
    actions: {
      move: (id, into, at) => post.move({ id, into, at }),
      remove: id => post.drop({ id }),
      add: (into, title, key) => post.add({ into, title }, key),
      load: () => board.refresh(),
    },
    post: {
      pause: () => post.pause(),
      resume: () => post.resume(),
      owed: post.owed,
      shelf: post.shelf,
    },
    dispose: () => post.pause(),
  }
}
