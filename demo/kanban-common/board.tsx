// The board itself, state-agnostic: it takes data and callbacks and knows
// nothing about who keeps the state. Both implementations render this very
// component — the screen is a common member and cancels out.

import { useEffect, useMemo, useRef, useState } from 'react'
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
import type { DragEndEvent, DragOverEvent, DragStartEvent } from '@dnd-kit/core'
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
  const { columns: settled, cardOf, onMove } = props
  const [dragged, setDragged] = useState<string | null>(null)
  // The gesture's echo: a fact of the screen. When the state lives a wire away
  // (a carried board), the hope lands one crossing later than the drop — and a
  // drop animated onto an unchanged layout snaps back like a refused drag. The
  // board itself shows the gesture at once and lets go when the state catches
  // up; in place the state changes in the same tick and the echo lives for
  // exactly zero frames.
  const [echo, setEcho] = useState<{ id: string; into: string; at: number } | null>(null)
  const holding = useRef(false) // a gesture in progress keeps its echo alive
  useEffect(() => {
    if (!holding.current) setEcho(null) // the layout moved: the truth is its again
  }, [settled])
  const columns = useMemo(() => {
    if (echo === null) return settled
    return settled.map(column => {
      const cardIds = column.cardIds.filter(id => id !== echo.id)
      if (column.id !== echo.into)
        return cardIds.length === column.cardIds.length ? column : { ...column, cardIds }
      const at = Math.min(echo.at, cardIds.length)
      return { ...column, cardIds: [...cardIds.slice(0, at), echo.id, ...cardIds.slice(at)] }
    })
  }, [settled, echo])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const columnOf = (cardId: string): BoardColumnView | undefined =>
    columns.find(c => c.cardIds.includes(cardId))

  const onDragStart = (e: DragStartEvent): void => {
    holding.current = true
    setDragged(String(e.active.id))
  }

  // Where would the card land if let go right here? `at` counts positions in
  // the list without the card itself — the same meaning the echo applies.
  const landing = (cardId: string, overId: string): { into: string; at: number } | null => {
    const target = columns.find(c => c.id === overId)
    if (target !== undefined)
      return { into: target.id, at: target.cardIds.filter(id => id !== cardId).length }
    const host = columnOf(overId)
    if (host === undefined) return null
    const ids = host.cardIds.filter(id => id !== cardId)
    return { into: host.id, at: Math.max(0, ids.indexOf(overId)) }
  }

  const onDragOver = (e: DragOverEvent): void => {
    const { active, over } = e
    if (over === null) return
    const cardId = String(active.id)
    const overId = String(over.id)
    if (cardId === overId) return
    const spot = landing(cardId, overId)
    if (spot === null) return
    // The live echo: the card belongs to the hovered column while the gesture
    // lasts, so the outline and the parted neighbours appear across columns
    // exactly as they do within one.
    if (echo === null || echo.into !== spot.into || echo.at !== spot.at)
      setEcho({ id: cardId, ...spot })
  }

  const onDragEnd = (e: DragEndEvent): void => {
    holding.current = false
    setDragged(null)
    const { active, over } = e
    if (over === null) {
      setEcho(null)
      return
    }
    const cardId = String(active.id)
    const overId = String(over.id)
    const spot =
      cardId === overId
        ? echo?.id === cardId
          ? { into: echo.into, at: echo.at }
          : null
        : landing(cardId, overId)
    if (spot === null) {
      setEcho(null)
      return
    }
    setEcho({ id: cardId, ...spot })
    onMove(cardId, spot.into, spot.at)
  }

  const draggedCard = dragged === null ? undefined : cardOf(dragged)

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        holding.current = false
        setDragged(null)
        setEcho(null)
      }}
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
