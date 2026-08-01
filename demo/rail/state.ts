// The whole state of the rail. There is no reducer, no epic, no reconnection
// bookkeeping and no merge code: what things are is declared here, how changes
// travel is the library's business.

import { command, input, table, watch } from '#weft'
import type { Command, Input, Ordered, SourceTable, Watchable } from '#weft'
import type { Game, RailServer, Status } from './server.ts'

export type Shelf = Status | 'all'
export const PAGE = 40

export interface Rail {
  games: SourceTable<Game>
  shelf: Input<Shelf>
  shelves: Record<Shelf, Ordered<Game>>
  counts: Record<Shelf, Watchable<number>>
  /** Goals across everything live right now. A fold, not a recount. */
  goals: Watchable<number>
  /** Games the server bore after this rail opened. */
  arrivals: Watchable<number>
  /** The furthest row any screen has looked at. Screens report it; pages follow. */
  reach: Input<number>
  loaded: Input<number>
  nextPage: Command<[], void>
  dispose(): void
}

export function rail(server: RailServer): Rail {
  const openedAt = Date.now()
  let quiet = (): void => {}

  /** Everything the client knows. The live feed follows the first look;
   *  a slow page loses to the event that overtook it. */
  const games = table<Game>({
    name: 'games',
    key: g => g.id,
    wins: (next, prev) => next.rev >= prev.rev,
    onDemand: () => {
      quiet = server.live(delta => games.apply(delta))
    },
    onIdle: () => quiet(),
  })

  const loaded = input(0, { name: 'loaded' })
  const total = input<number | null>(null, { name: 'total' })
  const reach = input(0, { name: 'reach' })

  const nextPage = command(
    async () => {
      const got = await server.page(loaded.peek(), PAGE)
      games.put(...got.items)
      total.set(got.total)
      loaded.set(Math.min(loaded.peek() + PAGE, got.total))
    },
    { name: 'nextPage' },
  )

  // The one standing order: a look near the edge of what is loaded asks for more.
  const stopFeeding = watch(() => {
    if (nextPage.pending.get()) return
    const has = loaded.get()
    const cap = total.get()
    if (cap !== null && has >= cap) return
    if (reach.get() + PAGE / 2 < has) return
    void nextPage.run()
  })

  const byStart = (a: Game, b: Game): number => a.start - b.start

  const live = games.where(g => g.status === 'live', 'live')
  const upcoming = games.where(g => g.status === 'upcoming', 'upcoming')
  const final = games.where(g => g.status === 'final', 'final')

  const shelves: Record<Shelf, Ordered<Game>> = {
    all: games.orderBy(byStart, 'all.order'),
    live: live.orderBy(byStart, 'live.order'),
    upcoming: upcoming.orderBy(byStart, 'upcoming.order'),
    final: final.orderBy(byStart, 'final.order'),
  }

  const counts: Record<Shelf, Watchable<number>> = {
    all: games.size,
    live: live.size,
    upcoming: upcoming.size,
    final: final.size,
  }

  const goals = live.sumBy(g => g.score.h + g.score.a)
  const arrivals = games.count(g => g.born > openedAt)

  const shelf = input<Shelf>('all', { name: 'shelf' })

  return {
    games,
    shelf,
    shelves,
    counts,
    goals,
    arrivals,
    reach,
    loaded,
    nextPage,
    dispose: stopFeeding,
  }
}
