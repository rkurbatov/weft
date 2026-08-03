// oxlint-disable oxc/no-map-spread -- a fake server hands out copies: callers
// must never hold the server's own objects.
// The far side of the rail: a catalogue served in pages, and a live feed that
// keeps moving while the pages travel. A page is photographed when asked and
// delivered later — so a page can, and regularly does, arrive already stale.
// That race is the point: the client has to survive it.

export type Sport = 'football' | 'basketball' | 'hockey' | 'soccer'
export type Status = 'upcoming' | 'live' | 'final'

export interface Game {
  id: number
  sport: Sport
  home: string
  away: string
  start: number
  /** When the server first learned of the game. */
  born: number
  status: Status
  score: { h: number; a: number }
  /** Grows with every change on the server; the client's precedence rule. */
  rev: number
}

export interface GameDelta {
  put?: Game[]
  drop?: number[]
}

export interface PageAnswer {
  items: Game[]
  total: number
}

export interface GameDetails {
  venue: string
  attendance: number
}

export interface GameOdds {
  h: number
  x: number
  a: number
}

export interface RailServer {
  page(offset: number, limit: number): Promise<PageAnswer>
  /** Deltas from now on. The ticker runs only while somebody listens. */
  live(listener: (delta: GameDelta) => void): () => void
  /** Find games by a team's name. A separate, slower service — as in life. */
  search(text: string): Promise<Game[]>
  details(id: number): Promise<GameDetails>
  odds(id: number): Promise<GameOdds>
  watching(): number
  /** How many searches were actually asked. For the tests' eyes. */
  searches(): number
}

export interface ServerOptions {
  seed?: number
  size?: number
  pageDelay?: number
  tickEvery?: number
  clock?: () => number
}

const HOUR = 3_600_000
const RUNNING = 2.5 * HOUR

const SIDES: Record<Sport, string[]> = {
  football: ['Ironfield', 'North Pier', 'Redhollow', 'Granite Bay', 'Salt Flats', 'Millbrook'],
  basketball: ['Harbor City', 'Duneside', 'Old Quarry', 'Riverlight', 'Kestrel Park', 'Westgate'],
  hockey: ['Frostvale', 'Pinewatch', 'Longshore', 'Cinder Lake', 'Blackbirch', 'Tallgate'],
  soccer: ['Verdana', 'Portello', 'Alta Roca', 'San Miro', 'Costa Bruna', 'Fiorane'],
}

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

export function railServer(options: ServerOptions = {}): RailServer {
  const chance = seeded(options.seed ?? 20260801)
  const size = options.size ?? 400
  const pageDelay = options.pageDelay ?? 250
  const tickEvery = options.tickEvery ?? 700
  const now = options.clock ?? Date.now

  const catalog = new Map<number, Game>()
  let nextId = 1

  const pick = <T>(list: readonly T[]): T => {
    const item = list[Math.floor(chance() * list.length)]
    if (item === undefined) throw new Error('empty list')
    return item
  }

  const statusFor = (start: number, t: number): Status =>
    start > t ? 'upcoming' : t - start < RUNNING ? 'live' : 'final'

  const bear = (start: number): Game => {
    const t = now()
    const sport = pick(Object.keys(SIDES) as Sport[])
    const home = pick(SIDES[sport])
    let away = pick(SIDES[sport])
    while (away === home) away = pick(SIDES[sport])
    const status = statusFor(start, t)
    const played = status === 'upcoming' ? 0 : 1
    return {
      id: nextId++,
      sport,
      home,
      away,
      start,
      born: t,
      status,
      score: { h: played * Math.floor(chance() * 4), a: played * Math.floor(chance() * 4) },
      rev: 1,
    }
  }

  const t0 = now()
  for (let i = 0; i < size; i++) {
    const game = bear(t0 - 6 * HOUR + chance() * 54 * HOUR)
    catalog.set(game.id, game)
  }

  const listeners = new Set<(delta: GameDelta) => void>()
  let ticker: ReturnType<typeof setInterval> | null = null

  const tick = (): void => {
    const t = now()
    const put: Game[] = []
    const drop: number[] = []
    for (const game of catalog.values()) {
      const due = statusFor(game.start, t)
      if (due !== game.status) {
        // The game crosses a line: it goes live, or it ends.
        const next = { ...game, status: due, rev: game.rev + 1 }
        catalog.set(game.id, next)
        put.push(next)
      } else if (game.status === 'live' && chance() < 0.04) {
        const h = chance() < 0.55
        const next = {
          ...game,
          score: { h: game.score.h + (h ? 1 : 0), a: game.score.a + (h ? 0 : 1) },
          rev: game.rev + 1,
        }
        catalog.set(game.id, next)
        put.push(next)
      }
    }
    if (chance() < 0.15) {
      const fresh = bear(t + chance() * 48 * HOUR)
      catalog.set(fresh.id, fresh)
      put.push(fresh)
    }
    if (put.length > 0 || drop.length > 0) {
      const delta: GameDelta = { ...(put.length ? { put } : {}), ...(drop.length ? { drop } : {}) }
      for (const listener of listeners) listener(delta)
    }
  }

  let searched = 0

  return {
    search(text) {
      searched++
      const needle = text.trim().toLowerCase()
      const items = [...catalog.values()]
        .filter(g => g.home.toLowerCase().includes(needle) || g.away.toLowerCase().includes(needle))
        .toSorted((a, b) => a.start - b.start || a.id - b.id)
        .slice(0, 20)
        .map(g => ({ ...g, score: { ...g.score } }))
      return new Promise(resolve => setTimeout(() => resolve(items), pageDelay))
    },
    details(id) {
      const game = catalog.get(id)
      return new Promise((resolve, reject) =>
        setTimeout(() => {
          if (game === undefined) reject(new Error('not found'))
          else resolve({ venue: `${game.home} Grounds`, attendance: 3000 + ((id * 977) % 42000) })
        }, pageDelay * 0.8),
      )
    },
    odds(id) {
      const game = catalog.get(id)
      return new Promise((resolve, reject) =>
        setTimeout(() => {
          if (game === undefined) reject(new Error('not found'))
          else {
            const h = 1.5 + ((id * 13) % 20) / 10
            const a = 1.5 + ((id * 29) % 25) / 10
            resolve({ h, x: 3.1 + ((id * 7) % 12) / 10, a })
          }
        }, pageDelay * 1.8),
      )
    },
    searches: () => searched,
    page(offset, limit) {
      // Photographed now, delivered later: rows are copies, revs are of this moment.
      const items = [...catalog.values()]
        .toSorted((a, b) => a.start - b.start || a.id - b.id)
        .slice(offset, offset + limit)
        .map(g => ({ ...g, score: { ...g.score } }))
      const total = catalog.size
      return new Promise(resolve => setTimeout(() => resolve({ items, total }), pageDelay))
    },
    live(listener) {
      listeners.add(listener)
      if (ticker === null) ticker = setInterval(tick, tickEvery)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && ticker !== null) {
          clearInterval(ticker)
          ticker = null
        }
      }
    },
    watching: () => listeners.size,
  }
}
