// oxlint-disable oxc/no-map-spread -- a fake server hands out copies: callers
// must never hold the server's own objects.
// The far side, shared by both implementations verbatim. It is slow on
// purpose, it fails some writes on purpose, and a bot keeps editing the board
// so the client's picture goes stale on its own.

import type { BoardSnapshot, Card, ColumnData, Tag } from './types.ts'

export interface KanbanServer {
  board(): Promise<BoardSnapshot>
  /** Cheap: for polling. */
  version(): Promise<number>
  moveCard(id: string, toColumn: string, toIndex: number): Promise<void>
  /** `key` is the client's idempotency key: the server answers a repeat with
   *  the very card it already made for that key. */
  addCard(column: string, title: string, tag: Tag, key?: string): Promise<Card>
  /** Lose the next reply of the named call once: the work happens, the answer
   *  does not arrive. For trials of the law of the key. */
  tripwire(call: 'addCard'): void
  deleteCard(id: string): Promise<void>
  /** The bot: somebody else's edits. Runs until stopped. */
  startBot(): () => void
}

export interface ServerOptions {
  seed?: number
  latency?: number
  /** Share of writes refused with a conflict. */
  grumpiness?: number
  botEvery?: number
}

const TITLES = [
  'Fix login redirect loop',
  'Migrate build to vite',
  'Card image flickers on hover',
  'Add keyboard shortcuts to editor',
  'Payment webhook retries forever',
  'Dark theme for settings page',
  'Profile avatar upload fails on safari',
  'Cache invalidation on logout',
  'Search ignores diacritics',
  'Onboarding checklist widget',
  'Rate limiter counts preflight requests',
  'Export board to csv',
  'Session expires during checkout',
  'Autosave drafts of comments',
  'Chart tooltip overflows viewport',
  'Dedupe notification emails',
  'Slow query on activity feed',
  'Drag handle invisible on touch',
  'Locale switch drops query params',
  'Archive completed cards weekly',
  'Websocket reconnect storms',
  'Empty state for filtered board',
  'Currency rounding in invoices',
  'Sync labels with tracker',
]

const TAGS: Tag[] = ['bug', 'feature', 'chore']

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

export function kanbanServer(options: ServerOptions = {}): KanbanServer {
  const chance = seeded(options.seed ?? 20260801)
  const latency = options.latency ?? 300
  const grumpiness = options.grumpiness ?? 0.12
  const botEvery = options.botEvery ?? 6500

  const pick = <T>(list: readonly T[]): T => {
    const item = list[Math.floor(chance() * list.length)]
    if (item === undefined) throw new Error('empty list')
    return item
  }

  let nextCard = 1
  let nextTitle = 0
  let version = 1
  const made = new Map<string, Card>()
  const lost = new Set<string>()
  const cards = new Map<string, Card>()
  const columns = new Map<string, ColumnData>()
  for (const [id, title, limit] of [
    ['backlog', 'Backlog', 99],
    ['progress', 'In progress', 4],
    ['review', 'Review', 3],
    ['done', 'Done', 99],
  ] as const) {
    columns.set(id, { id, title, cardIds: [], limit })
  }

  const bear = (column: string): Card => {
    const title = TITLES[nextTitle % TITLES.length] ?? 'Untitled'
    nextTitle++
    const card: Card = { id: `c${nextCard++}`, title, tag: pick(TAGS) }
    cards.set(card.id, card)
    columns.get(column)?.cardIds.push(card.id)
    return card
  }

  for (const [column, count] of [
    ['backlog', 9],
    ['progress', 3],
    ['review', 2],
    ['done', 6],
  ] as const) {
    for (let i = 0; i < count; i++) bear(column)
  }

  const slow = <T>(value: () => T): Promise<T> =>
    new Promise((resolve, reject) =>
      setTimeout(
        () => {
          try {
            resolve(value())
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        },
        latency * (0.6 + chance() * 0.8),
      ),
    )

  const columnOf = (cardId: string): ColumnData | undefined => {
    for (const column of columns.values()) if (column.cardIds.includes(cardId)) return column
    return undefined
  }

  const doMove = (id: string, toColumn: string, toIndex: number): void => {
    const from = columnOf(id)
    const to = columns.get(toColumn)
    if (from === undefined || to === undefined) throw new Error('not found')
    from.cardIds.splice(from.cardIds.indexOf(id), 1)
    to.cardIds.splice(Math.max(0, Math.min(toIndex, to.cardIds.length)), 0, id)
    version++
  }

  const bot = (): void => {
    const roll = chance()
    if (roll < 0.7) {
      // Move somebody's card, most often forward.
      const from = pick([...columns.values()].filter(c => c.cardIds.length > 0))
      const id = pick(from.cardIds)
      const to = pick([...columns.keys()])
      doMove(id, to, Math.floor(chance() * ((columns.get(to)?.cardIds.length ?? 0) + 1)))
    } else if (roll < 0.9) {
      bear('backlog')
      version++
    } else {
      const done = columns.get('done')
      if (done !== undefined && done.cardIds.length > 0) {
        const id = done.cardIds[0]
        if (id !== undefined) {
          done.cardIds.shift()
          cards.delete(id)
          version++
        }
      }
    }
  }

  return {
    board: () =>
      slow(() => ({
        columns: [...columns.values()].map(c => ({ ...c, cardIds: [...c.cardIds] })),
        cards: [...cards.values()].map(c => ({ ...c })),
        version,
      })),
    version: () => slow(() => version),
    moveCard: (id, toColumn, toIndex) =>
      slow(() => {
        if (chance() < grumpiness) throw new Error('conflict: somebody edited the board')
        doMove(id, toColumn, toIndex)
      }),
    addCard: (column, title, tag, key) =>
      slow(() => {
        if (!columns.has(column)) throw new Error('not found')
        const repeat = key === undefined ? undefined : made.get(key)
        if (repeat !== undefined) return { ...repeat } // the key names a card already made
        if (chance() < grumpiness) throw new Error('conflict: somebody edited the board')
        const card: Card = { id: `c${nextCard++}`, title, tag }
        cards.set(card.id, card)
        columns.get(column)?.cardIds.push(card.id)
        if (key !== undefined) made.set(key, card)
        version++
        if (lost.delete('addCard')) throw new Error('network: the reply was lost')
        return { ...card }
      }),
    tripwire: call => {
      lost.add(call)
    },
    deleteCard: id =>
      slow(() => {
        const from = columnOf(id)
        if (from === undefined) throw new Error('not found')
        if (chance() < grumpiness) throw new Error('conflict: somebody edited the board')
        from.cardIds.splice(from.cardIds.indexOf(id), 1)
        cards.delete(id)
        version++
      }),
    startBot: () => {
      const timer = setInterval(bot, botEvery)
      return () => clearInterval(timer)
    },
  }
}
