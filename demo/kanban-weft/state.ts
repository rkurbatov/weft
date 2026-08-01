// The kanban in the library's own liturgy. Four visible phases: what things
// are, the truth of the server, what reaches the world, what follows. Rollback
// and poll guards do not exist as code: a refusal removes its entry, a snapshot
// lands whenever it lands, and the visible board is always base plus replay.

import { cell, command, heldOf, input, memoryStore, outbox, source } from '#weft'
import { alike } from '#weft'
import type { Outbox, Readable } from '#weft'
import type { BoardSnapshot, Card, ColumnData } from '../kanban-common/types.ts'
import type { KanbanServer } from '../kanban-common/server.ts'

export interface Kanban {
  state: {
    layout: Readable<ColumnData[]>
    cards: Readable<ReadonlyMap<string, Card>>
    /** Cards with our own entry still owed to the world. */
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

// ── The applicator ─────────────────────────────────────────────────────────
// Four laws. Absolute: the intent names the target, never the past. Total:
// wherever the subject stands — take it out, put it here. Void: no subject in
// the base — no application, silently. Idempotent: twice is once. Entries
// replay in queue order; under these four, replay is safe on any base.

type Op =
  | { kind: 'move'; id: string; into: string; at: number }
  | { kind: 'drop'; id: string }
  | { kind: 'add'; card: Card; into: string }

interface SettledOp {
  op: Op
  confirmedAt: number
}

function without(columns: ColumnData[], id: string): ColumnData[] {
  return columns.map(c =>
    c.cardIds.includes(id) ? { ...c, cardIds: c.cardIds.filter(x => x !== id) } : c,
  )
}

function placed(columns: ColumnData[], id: string, into: string, at: number): ColumnData[] {
  return columns.map(c => {
    if (c.id !== into) return c
    const index = Math.max(0, Math.min(at, c.cardIds.length))
    return { ...c, cardIds: [...c.cardIds.slice(0, index), id, ...c.cardIds.slice(index)] }
  })
}

function applyOp(columns: ColumnData[], known: ReadonlySet<string>, op: Op): ColumnData[] {
  switch (op.kind) {
    case 'move':
      if (!known.has(op.id)) return columns // void: the subject is gone
      return placed(without(columns, op.id), op.id, op.into, op.at)
    case 'drop':
      return without(columns, op.id)
    case 'add':
      // The op carries its subject; re-placing is what makes it idempotent.
      return placed(without(columns, op.card.id), op.card.id, op.into, Number.MAX_SAFE_INTEGER)
  }
}

export function kanban(server: KanbanServer, pollMs = 4000): Kanban {
  // ── What things are ──────────────────────────────────────────────────────
  /** Confirmed but not yet absorbed: the server said yes, the base does not
   *  know it yet. Removing these early would flash the screen backwards. */
  const settled = input<readonly SettledOp[]>([], { name: 'settled' })
  const notice = input<string | null>(null, { name: 'notice' })
  const addingIn = input<string | null>(null, { name: 'addingIn' })

  let hush: ReturnType<typeof setTimeout> | undefined
  const report = (what: unknown): void => {
    notice.set(what instanceof Error ? what.message : String(what))
    clearTimeout(hush)
    hush = setTimeout(() => notice.set(null), 4000)
  }

  // ── The truth of the server ──────────────────────────────────────────────
  // The answer carries the moment its question was asked: absorption of
  // settled entries is judged against that, conservatively. A cheap version
  // probe keeps an unchanged board from travelling again.
  interface Base {
    snapshot: BoardSnapshot
    askedAt: number
  }
  let held: Base | undefined
  const board = source<Base>(
    async () => {
      const askedAt = Date.now()
      const version = await server.version()
      if (held === undefined || held.snapshot.version !== version) {
        held = { snapshot: await server.board(), askedAt }
      } else {
        held = { snapshot: held.snapshot, askedAt }
      }
      return held
    },
    { name: 'board', every: pollMs },
  )

  const absorbedBy = (asked: number) => (s: SettledOp) => s.confirmedAt <= asked
  const settle = (op: Op): void => {
    const asked = held?.askedAt ?? Number.NEGATIVE_INFINITY
    const kept = settled.peek().filter(s => !absorbedBy(asked)(s))
    settled.set([...kept, { op, confirmedAt: Date.now() }])
  }

  // ── What reaches the world ───────────────────────────────────────────────
  const box = outbox({
    key: 'kanban',
    store: memoryStore(),
    handlers: {
      move: async raw => {
        const op = raw as { id: string; into: string; at: number }
        await server.moveCard(op.id, op.into, op.at)
        settle({ kind: 'move', ...op })
      },
      drop: async raw => {
        const op = raw as { id: string }
        await server.deleteCard(op.id)
        settle({ kind: 'drop', ...op })
      },
    },
    // The server's "conflict" is the world meaningfully saying no: rejected,
    // discarded at once, with a trace. Anything else would be transient.
    classify: error =>
      error instanceof Error && error.message.includes('conflict') ? 'rejected' : 'transient',
    onRefused: entry => report(entry.lastError ?? 'refused'),
  })

  const add = command(
    async (into: string, title: string) => {
      addingIn.set(into)
      try {
        const card = await server.addCard(into, title, 'feature')
        settle({ kind: 'add', card, into })
      } catch (refusal) {
        report(refusal)
      } finally {
        addingIn.set(null)
      }
    },
    { name: 'add' },
  )

  // ── What follows ─────────────────────────────────────────────────────────
  const base = cell(() => heldOf(board.state.get())?.value, { name: 'base' })

  const overlay = cell<readonly Op[]>(
    () => {
      const asked = base.get()?.askedAt ?? Number.NEGATIVE_INFINITY
      const confirmed = settled.get().filter(s => !absorbedBy(asked)(s))
      const flying = box.entries.get()
      const ops: Op[] = confirmed.map(s => s.op)
      for (const entry of flying) {
        if (entry.name === 'move')
          ops.push({ kind: 'move', ...(entry.args as { id: string; into: string; at: number }) })
        if (entry.name === 'drop') ops.push({ kind: 'drop', ...(entry.args as { id: string }) })
      }
      return ops
    },
    { name: 'overlay' },
  )

  // Cards keep their identity across snapshots: an unchanged card is the same
  // object, so a memoized screen stays quiet through a poll.
  const sameCards = new Map<string, Card>()
  const keep = (card: Card): Card => {
    const was = sameCards.get(card.id)
    if (was !== undefined && alike(was, card)) return was
    sameCards.set(card.id, card)
    return card
  }

  const cards = cell<ReadonlyMap<string, Card>>(
    () => {
      const map = new Map<string, Card>()
      for (const card of base.get()?.snapshot.cards ?? []) map.set(card.id, keep(card))
      for (const op of overlay.get()) if (op.kind === 'add') map.set(op.card.id, op.card)
      return map
    },
    { name: 'cards' },
  )

  const layout = cell(
    () => {
      const start = base.get()?.snapshot.columns ?? []
      const known = new Set(cards.get().keys())
      return overlay.get().reduce((columns, op) => applyOp(columns, known, op), start)
    },
    { name: 'layout' },
  )

  const busy = cell<ReadonlySet<string>>(
    () => {
      const ids = new Set<string>()
      for (const entry of box.entries.get()) {
        const args = entry.args as { id?: string }
        if (args.id !== undefined) ids.add(args.id)
      }
      return ids
    },
    { name: 'busy' },
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
      move: (id, into, at) => box.send('move', { id, into, at }).done.catch(() => {}),
      remove: id => box.send('drop', { id }).done.catch(() => {}),
      add: (into, title) =>
        add.run(into, title).then(
          () => undefined,
          () => undefined,
        ),
      load: () => board.refresh(),
    },
    post: box,
    dispose: () => {
      box.pause()
      clearTimeout(hush)
    },
  }
}
