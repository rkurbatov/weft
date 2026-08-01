// The board itself, state-agnostic: it takes data and callbacks and knows
// nothing about who keeps the state. Both implementations render this very
// component — the screen is a common member and cancels out.

import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Loader2, Plus, X } from 'lucide-react'
import { Badge } from './ui/badge.tsx'
import { Button } from './ui/button.tsx'
import { Card, CardContent } from './ui/card.tsx'
import { Input } from './ui/input.tsx'
import { cn } from './ui/cn.ts'
import type { Card as CardData } from './types.ts'

export interface BoardColumnView {
  id: string
  title: string
  limit: number
  cardIds: string[]
}

export interface BoardViewProps {
  columns: BoardColumnView[]
  cardOf(id: string): CardData | undefined
  /** The card has a write in flight: drawn dimmed, still draggable. */
  pending(id: string): boolean
  addBusy: string | null
  onMove(id: string, toColumn: string, toIndex: number): void
  onAdd(column: string, title: string): void
  onDelete(id: string): void
}

const TAG_STYLE: Record<CardData['tag'], string> = {
  bug: 'bg-red-100 text-red-800',
  feature: 'bg-blue-100 text-blue-800',
  chore: 'bg-zinc-100 text-zinc-700',
}

function TaskCard({
  card,
  pending,
  onDelete,
  shadow = false,
}: {
  card: CardData
  pending: boolean
  onDelete?: (id: string) => void
  shadow?: boolean
}): ReactNode {
  return (
    <Card className={cn('group relative', pending && 'opacity-60', shadow && 'shadow-lg')}>
      <CardContent className="flex flex-col gap-2 p-3">
        <span className="text-sm leading-snug">{card.title}</span>
        <span className="flex items-center gap-2">
          <span className={cn('rounded px-1.5 py-0.5 text-xs', TAG_STYLE[card.tag])}>
            {card.tag}
          </span>
          <span className="text-xs text-muted-foreground">{card.id}</span>
          {pending && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
        </span>
        {onDelete !== undefined && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1 hidden size-6 group-hover:inline-flex"
            onClick={() => onDelete(card.id)}
          >
            <X className="size-3" />
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

function SortableCard(props: {
  card: CardData
  pending: boolean
  onDelete: (id: string) => void
}): ReactNode {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.card.id,
  })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && 'opacity-30')}
      {...attributes}
      {...listeners}
    >
      <TaskCard {...props} />
    </div>
  )
}

function AddCard({
  column,
  busy,
  onAdd,
}: {
  column: string
  busy: boolean
  onAdd: (column: string, title: string) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  if (!open) {
    return (
      <Button variant="ghost" size="sm" className="justify-start" onClick={() => setOpen(true)}>
        <Plus /> Add card
      </Button>
    )
  }
  const submit = (): void => {
    const trimmed = title.trim()
    if (trimmed.length === 0) return
    onAdd(column, trimmed)
    setTitle('')
    setOpen(false)
  }
  return (
    <span className="flex gap-1">
      <Input
        autoFocus
        value={title}
        disabled={busy}
        placeholder="Card title"
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') setOpen(false)
        }}
      />
      <Button size="sm" disabled={busy} onClick={submit}>
        {busy ? <Loader2 className="animate-spin" /> : 'Add'}
      </Button>
    </span>
  )
}

function Column({
  column,
  cardOf,
  pending,
  addBusy,
  onAdd,
  onDelete,
}: { column: BoardColumnView } & Omit<BoardViewProps, 'columns' | 'onMove'>): ReactNode {
  const { setNodeRef } = useDroppable({ id: column.id })
  const over = column.cardIds.length > column.limit
  return (
    <section className="flex w-72 shrink-0 flex-col gap-2 rounded-xl bg-muted/60 p-2">
      <header className="flex items-center gap-2 px-1">
        <h2 className="text-sm font-semibold">{column.title}</h2>
        <Badge variant={over ? 'destructive' : 'secondary'}>
          {column.cardIds.length}
          {column.limit < 99 ? ` / ${column.limit}` : ''}
        </Badge>
      </header>
      <SortableContext items={column.cardIds} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="flex min-h-10 flex-col gap-2">
          {column.cardIds.map(id => {
            const card = cardOf(id)
            return card === undefined ? null : (
              <SortableCard key={id} card={card} pending={pending(id)} onDelete={onDelete} />
            )
          })}
        </div>
      </SortableContext>
      <AddCard column={column.id} busy={addBusy === column.id} onAdd={onAdd} />
    </section>
  )
}

export function BoardView(props: BoardViewProps): ReactNode {
  const { columns, cardOf, onMove } = props
  const [dragged, setDragged] = useState<string | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const columnOf = (cardId: string): BoardColumnView | undefined =>
    columns.find(c => c.cardIds.includes(cardId))

  const onDragStart = (e: DragStartEvent): void => setDragged(String(e.active.id))

  const onDragEnd = (e: DragEndEvent): void => {
    setDragged(null)
    const { active, over } = e
    if (over === null) return
    const cardId = String(active.id)
    const overId = String(over.id)
    if (cardId === overId) return
    const target = columns.find(c => c.id === overId)
    if (target !== undefined) {
      // Dropped on a column's body: goes to its end.
      onMove(cardId, target.id, target.cardIds.length)
      return
    }
    const host = columnOf(overId)
    if (host === undefined) return
    onMove(cardId, host.id, host.cardIds.indexOf(overId))
  }

  const draggedCard = dragged === null ? undefined : cardOf(dragged)

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragged(null)}
    >
      <div className="flex items-start gap-3 overflow-x-auto p-4">
        {columns.map(column => (
          <Column key={column.id} column={column} {...props} />
        ))}
      </div>
      <DragOverlay>
        {draggedCard !== undefined && (
          <TaskCard card={draggedCard} pending={props.pending(draggedCard.id)} shadow />
        )}
      </DragOverlay>
    </DndContext>
  )
}
