// The whole state of the rail. There is no reducer, no epic, no reconnection
// bookkeeping and no merge code: what things are is declared here, how changes
// travel is the library's business.

// Two engine words stand here on purpose: `command` for an action that only
// fetches (a page is a read, not an intent the world must remember) and `watch`
// for the one standing order. Whether the convenient layer wants words of its
// own for these is an open question in the register.
import { command, watch } from '#weft'
import type { Command, Port, Watchable } from '#weft'
import { live, fold, listsBy, cell, shape, truthBy } from '#loom'
import type { Live, ListView, Truth } from '#loom'
import type { Game, GameDetails, GameOdds, RailServer, Status } from './server.ts'

export type Shelf = Status | 'all'
export const PAGE = 40

export interface Rail {
  games: Live<Game>
  shelf: Port<Shelf>
  shelves: Record<Shelf, ListView<Game>>
  /** Goals across everything live right now. A fold, not a oracle. */
  goals: Watchable<number>
  /** Games the server bore after this rail opened. */
  arrivals: Watchable<number>
  /** The furthest row any screen has looked at. Screens report it; pages follow. */
  reach: Port<number>
  loaded: Port<number>
  nextPage: Command<[], void>
  /** What the person is typing. The question with a calm in its passport. */
  searchText: Port<string>
  find: (text: string) => Truth<Game[]>
  /** The opened game, if any; its details come from two services at once. */
  picked: Port<number | null>
  gameInfo: (id: number) => Truth<GameDetails | null>
  gameOdds: (id: number) => Truth<GameOdds | null>
  dispose(): void
}

const byStart = (a: Game, b: Game): number => a.start - b.start

export function rail(server: RailServer): Rail {
  const openedAt = Date.now()

  /** Everything the client knows. Feeding follows the first look; a slow page
   *  loses to the live event that overtook it. */
  const games = live<Game>({
    name: 'games',
    key: g => g.id,
    wins: (next, standing) => next.rev >= standing.rev,
    live: hand => server.live(hand),
  })

  const loaded = cell(0, { name: 'loaded' })
  const total = cell<number | null>(null, { name: 'total' })
  const reach = cell(0, { name: 'reach' })

  const nextPage = command(
    async () => {
      const got = await server.page(loaded.peek(), PAGE)
      games.take(got.items)
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

  // The collection half of this screen, as one form: what each shelf is, in
  // what order, and the two numbers the header shows.
  const board = shape(
    {
      shelves: listsBy(games, 'status', { order: byStart, whole: 'all' }),
      goals: fold(
        games,
        g => g.sum(r => r.score.h + r.score.a),
        g => g.status === 'live',
      ),
      arrivals: fold(
        games,
        g => g.count(),
        g => g.born > openedAt,
      ),
    },
    { name: 'rail' },
  )

  const shelves: Record<Shelf, ListView<Game>> = board.shelves

  const shelf = cell<Shelf>('all', { name: 'shelf' })

  // Search: the churn of typing asks only the question that survives the calm,
  // and a question abandoned mid-flight is disowned by the move itself.
  const searchText = cell('', { name: 'searchText' })
  const find = truthBy((text: string) => server.search(text), {
    name: 'find',
    calm: 250,
    keep: 32,
    empty: [] as Game[],
  })

  const picked = cell<number | null>(null, { name: 'picked' })
  const gameInfo = truthBy((id: number) => server.details(id), {
    name: 'gameInfo',
    keep: 16,
    empty: null as GameDetails | null,
  })
  const gameOdds = truthBy((id: number) => server.odds(id), {
    name: 'gameOdds',
    keep: 16,
    empty: null as GameOdds | null,
  })

  return {
    games,
    shelf,
    shelves,
    goals: board.goals as Watchable<number>,
    arrivals: board.arrivals as Watchable<number>,
    reach,
    loaded,
    nextPage,
    searchText,
    find,
    picked,
    gameInfo,
    gameOdds,
    dispose: stopFeeding,
  }
}
