// The kanban state, finally in the shape a developer solves his task in:
// declare what the base is, declare what each note does to it, hand the
// actions to the screen. Rollback, the three states of a note, absorption
// and referential identity are the library's business — none of it is here.

import { cell, command, heldOf, input, laneAppend, laneDrop, lanePlace, projected } from '#weft'
import type { Lanes, Outbox, Readable } from '#weft'
import type { Card, ColumnData } from '../kanban-common/types.ts'
import type { KanbanPorts } from './transport.ts'

export interface Kanban {
  state: {
    layout: Readable<ColumnData[]>
    cards: Readable<ReadonlyMap<string, Card>>
    /** Cards with our own note still owed to the world. */
    busy: Readable<ReadonlySet<string>>
    addBusy: Readable<string | null>
    notice: Readable<string | null>
    coldStart: Readable<boolean>
    fault: Readable<string | null>
  }
  actions: {
    move(id: string, into: string, at: number): Promise<void>
    remove(id: string): Promise<void>
    add(into: string, title: string): Promise<void>
    load(): Promise<void>
  }
  /** The letter carrier: pause() is going offline, resume() is coming back. */
  post: Outbox
  dispose(): void
}

/** What the board is, as the projection sees it. */
interface Board {
  lanes: Lanes<string>
  cards: Readonly<Record<string, Card>>
}

export function kanbanState(ports: KanbanPorts): Kanban {
  const { board, post } = ports

  const notice = input<string | null>(null, { name: 'notice' })
  const addingIn = input<string | null>(null, { name: 'addingIn' })

  let hush: ReturnType<typeof setTimeout> | undefined
  const report = (what: unknown): void => {
    notice.set(what instanceof Error ? what.message : String(what))
    clearTimeout(hush)
    hush = setTimeout(() => notice.set(null), 4000)
  }

  // ── The base, and what each note does to it ──────────────────────────────
  const base = cell<Board>(
    () => {
      const snapshot = heldOf(board.state.get())?.value.snapshot
      const lanes: Record<string, readonly string[]> = {}
      const cards: Record<string, Card> = {}
      for (const column of snapshot?.columns ?? []) lanes[column.id] = column.cardIds
      for (const card of snapshot?.cards ?? []) cards[card.id] = card
      return { lanes, cards }
    },
    { name: 'base' },
  )

  const visible = projected(base, post.entries, {
    name: 'visible',
    apply: {
      move: (b: Board, op: { id: string; into: string; at: number }) =>
        op.id in b.cards ? { ...b, lanes: lanePlace(b.lanes, op.id, op.into, op.at) } : b,
      drop: (b: Board, op: { id: string }) => ({ ...b, lanes: laneDrop(b.lanes, op.id) }),
      add: (b: Board, op: { card: Card; into: string }) => ({
        lanes: laneAppend(b.lanes, op.card.id, op.into),
        cards: { ...b.cards, [op.card.id]: op.card },
      }),
    },
  })

  // ── What the screen reads ────────────────────────────────────────────────
  const meta = cell(
    () =>
      (heldOf(board.state.get())?.value.snapshot.columns ?? []).map(({ id, title, limit }) => ({
        id,
        title,
        limit,
      })),
    { name: 'meta' },
  )

  const layout = cell<ColumnData[]>(
    () => {
      const lanes = visible.get().lanes
      return meta.get().map(column => ({ ...column, cardIds: [...(lanes[column.id] ?? [])] }))
    },
    { name: 'layout' },
  )

  const cards = cell<ReadonlyMap<string, Card>>(
    () => new Map(Object.entries(visible.get().cards)),
    { name: 'cards' },
  )

  const busy = cell<ReadonlySet<string>>(
    () => {
      const ids = new Set<string>()
      for (const entry of post.entries.get()) {
        if (entry.state === 'done') continue
        const args = entry.args as { id?: string }
        if (args.id !== undefined) ids.add(args.id)
      }
      return ids
    },
    { name: 'busy' },
  )

  // ── What reaches the world ───────────────────────────────────────────────
  const add = command(
    async (into: string, title: string) => {
      addingIn.set(into)
      try {
        const card = await ports.create(into, title)
        post.note('add', { card, into }) // a fait accompli: lays over until the base absorbs it
      } catch (refusal) {
        report(refusal)
      } finally {
        addingIn.set(null)
      }
    },
    { name: 'add' },
  )

  const addBusy = cell(() => (add.pending.get() ? addingIn.get() : null), { name: 'addBusy' })
  const coldStart = cell(
    () => {
      const s = board.state.get()
      return s.value === undefined && s.loading
    },
    { name: 'coldStart' },
  )
  const fault = cell(
    () => {
      const s = board.state.get()
      return s.kind === 'failed' && s.value === undefined ? String(s.error) : null
    },
    { name: 'fault' },
  )

  return {
    state: { layout, cards, busy, addBusy, notice, coldStart, fault },
    actions: {
      move: (id, into, at) => post.send('move', { id, into, at }).done.catch(report),
      remove: id => post.send('drop', { id }).done.catch(report),
      add: (into, title) =>
        add.run(into, title).then(
          () => undefined,
          () => undefined,
        ),
      load: () => board.refresh(),
    },
    post,
    dispose: () => clearTimeout(hush),
  }
}
