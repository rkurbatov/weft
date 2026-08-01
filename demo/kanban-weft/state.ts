// The whole state of the kanban. What things are is declared at the top; each
// user action below is one function read top to bottom: the hope, the ask,
// the retreat. Nothing else keeps books.

import { batch, input, table } from '#weft'
import type { Input, SourceTable } from '#weft'
import type { Card, ColumnData } from '../kanban-common/types.ts'
import type { KanbanServer } from '../kanban-common/server.ts'

export interface Kanban {
  cards: SourceTable<Card>
  layout: Input<ColumnData[]>
  loading: Input<boolean>
  error: Input<string | null>
  addBusy: Input<string | null>
  writes: Input<ReadonlySet<string>>
  notice: Input<string | null>
  load(first?: boolean): Promise<void>
  move(id: string, toColumn: string, toIndex: number): Promise<void>
  remove(id: string): Promise<void>
  add(column: string, title: string): Promise<void>
  dispose(): void
}

// The layout is column lists in board order; these shuffle it.

function without(columns: ColumnData[], id: string): ColumnData[] {
  return columns.map(c =>
    c.cardIds.includes(id) ? { ...c, cardIds: c.cardIds.filter(x => x !== id) } : c,
  )
}

function placed(columns: ColumnData[], id: string, into: string, index: number): ColumnData[] {
  return columns.map(c => {
    if (c.id !== into) return c
    const at = Math.max(0, Math.min(index, c.cardIds.length))
    return { ...c, cardIds: [...c.cardIds.slice(0, at), id, ...c.cardIds.slice(at)] }
  })
}

function positionOf(columns: ColumnData[], id: string): { column: string; index: number } | null {
  for (const c of columns) {
    const index = c.cardIds.indexOf(id)
    if (index >= 0) return { column: c.id, index }
  }
  return null
}

export function kanban(server: KanbanServer, pollMs = 4000): Kanban {
  /** Card contents by id. A reload keeps untouched cards as the same objects. */
  const cards = table<Card>({ name: 'cards', key: c => c.id })
  /** Where everything stands. One value, replaced whole. */
  const layout = input<ColumnData[]>([], { name: 'layout' })

  const loading = input(false, { name: 'loading' })
  const error = input<string | null>(null, { name: 'error' })
  const version = input(0, { name: 'version' })
  const addBusy = input<string | null>(null, { name: 'addBusy' })
  /** Cards with our own write in flight: drawn dimmed, and the poll holds off. */
  const writes = input<ReadonlySet<string>>(new Set(), { name: 'writes' })
  const notice = input<string | null>(null, { name: 'notice' })

  let hush: ReturnType<typeof setTimeout> | undefined
  const report = (what: unknown): void => {
    notice.set(String(what))
    clearTimeout(hush)
    hush = setTimeout(() => notice.set(null), 4000)
  }

  const writing = (id: string, on: boolean): void => {
    writes.update(was => {
      const next = new Set(was)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  async function load(first = false): Promise<void> {
    if (first) {
      loading.set(true)
      error.set(null)
    }
    try {
      const got = await server.board()
      batch(() => {
        cards.replace(got.cards)
        layout.set(got.columns)
        version.set(got.version)
        loading.set(false)
      })
    } catch (failure) {
      loading.set(false)
      if (first) error.set(String(failure))
    }
  }

  async function move(id: string, toColumn: string, toIndex: number): Promise<void> {
    const origin = positionOf(layout.peek(), id)
    if (origin === null) return
    layout.update(l => placed(without(l, id), id, toColumn, toIndex))
    writing(id, true)
    try {
      await server.moveCard(id, toColumn, toIndex)
    } catch (refusal) {
      layout.update(l => placed(without(l, id), id, origin.column, origin.index))
      report(refusal)
    } finally {
      writing(id, false)
    }
  }

  async function remove(id: string): Promise<void> {
    const origin = positionOf(layout.peek(), id)
    const held = cards.peek(id)
    if (origin === null || held === undefined) return
    batch(() => {
      layout.update(l => without(l, id))
      cards.drop(id)
    })
    writing(id, true)
    try {
      await server.deleteCard(id)
    } catch (refusal) {
      batch(() => {
        cards.put(held)
        layout.update(l => placed(l, id, origin.column, origin.index))
      })
      report(refusal)
    } finally {
      writing(id, false)
    }
  }

  async function add(column: string, title: string): Promise<void> {
    addBusy.set(column)
    try {
      const card = await server.addCard(column, title, 'feature')
      batch(() => {
        cards.put(card)
        layout.update(l => placed(l, card.id, column, Number.MAX_SAFE_INTEGER))
      })
    } catch (refusal) {
      report(refusal)
    } finally {
      addBusy.set(null)
    }
  }

  // The poll: reload when the server moved on — unless our own hope is in flight.
  const timer = setInterval(() => {
    void server
      .version()
      .then(v => {
        const idle = writes.peek().size === 0 && addBusy.peek() === null && !loading.peek()
        if (v > version.peek() && idle) void load()
      })
      .catch(() => {})
  }, pollMs)

  return {
    cards,
    layout,
    loading,
    error,
    addBusy,
    writes,
    notice,
    load,
    move,
    remove,
    add,
    dispose: () => {
      clearInterval(timer)
      clearTimeout(hush)
    },
  }
}
