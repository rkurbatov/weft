// The screen. Components read cells and report what they look at — that is all.
// The window is a cell of the ordered shelf; a card reads its own row and wakes
// alone when its score moves. The render counter in the bar is the proof.

import { memo, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useField, useKeepRow, useLive } from '#loom/react'
import { WavesPanel } from '../common/waves.ts'
import { countCellRender, useCounters } from '../common/stats.ts'
import { railServer } from './server.ts'
import { rail } from './state.ts'
import type { Shelf } from './state.ts'
import type { Game } from './server.ts'

const app = rail(railServer())

const ROW = 58
const OVERSCAN = 6
const SHELVES: Shelf[] = ['all', 'live', 'upcoming', 'final']

const clock = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })

const Card = memo(function Card({ id }: { id: number }): ReactNode {
  countCellRender()
  const game = useLive(() => app.games.row(id).get())
  if (game === undefined) return null
  const fresh = Date.now() - game.born < 15_000
  return (
    <div
      className={`card ${game.status}${fresh ? ' fresh' : ''}`}
      style={{ height: ROW }}
      onClick={() => app.picked.set(id)}
    >
      <span className="sport">{game.sport}</span>
      <span className="sides">
        {game.home} — {game.away}
      </span>
      {game.status === 'upcoming' ? (
        <span className="when">{clock(game.start)}</span>
      ) : (
        <span className="net">
          {game.score.h}:{game.score.a}
        </span>
      )}
      <span className="chip">{game.status}</span>
      <span className="rev">r{game.rev}</span>
    </div>
  )
})

function Tab({ name }: { name: Shelf }): ReactNode {
  const live = useLive(() => ({ picked: app.shelf.get() === name, count: app.counts[name].get() }))
  const { picked, count } = live
  return (
    <button className={picked ? 'tab on' : 'tab'} onClick={() => app.shelf.set(name)}>
      {name} <b>{count}</b>
    </button>
  )
}

function Search(): ReactNode {
  const box = useField(app.searchText) // the two-way seam, spread and done
  const text = box.value.trim()
  return (
    <span className="search">
      <input placeholder="find a team" {...box} />
      {text.length >= 2 && <Matches text={text} />}
    </span>
  )
}

function Matches({ text }: { text: string }): ReactNode {
  // The calm in the passport means the churn of typing asks once; the law of
  // the adjective means the old list keeps showing while the new travels.
  const found = app.find(text)
  const live = useLive(() => ({
    games: found.get(),
    flight: found.flight.get(),
    asked: found.asked.get(),
  }))
  return (
    <span className="matches">
      {live.flight && <span className="dim">…</span>}
      {live.games.slice(0, 6).map(game => (
        <button key={game.id} onClick={() => app.picked.set(game.id)}>
          {game.home} — {game.away}
        </button>
      ))}
      {live.asked > 0 && live.games.length === 0 && <span className="dim">nobody</span>}
    </span>
  )
}

function Details({ id }: { id: number }): ReactNode {
  // Two services answer at their own pace. Under the law of the adjective,
  // joining them is an ordinary formula over plain values — no combinator,
  // no unwrapping: both here when both are here, in flight while either flies.
  const info = app.gameInfo(id)
  const odds = app.gameOdds(id)
  const live = useLive(() => ({
    game: app.games.row(id).get(),
    info: info.get(),
    odds: odds.get(),
    flight: info.flight.get() || odds.flight.get(),
    fault: info.fault.get() ?? odds.fault.get(),
  }))
  return (
    <aside className="details">
      <header>
        <b>{live.game === undefined ? `game ${id}` : `${live.game.home} — ${live.game.away}`}</b>
        <button onClick={() => app.picked.set(null)}>×</button>
      </header>
      {live.flight && (live.info === null || live.odds === null) && (
        <p className="dim">asking two services…</p>
      )}
      {live.info !== null && live.odds !== null && (
        <p>
          {live.info.venue} · {live.info.attendance.toLocaleString()} seats
          <br />
          odds {live.odds.h.toFixed(2)} / {live.odds.x.toFixed(2)} / {live.odds.a.toFixed(2)}
        </p>
      )}
      {live.fault !== null && <p className="gate">{live.fault}</p>}
    </aside>
  )
}

function Meter(): ReactNode {
  const { cellRenders } = useCounters()
  const { goals, loaded, arrivals } = useLive(() => ({
    goals: app.goals.get(),
    loaded: app.loaded.get(),
    arrivals: app.arrivals.get(),
  }))
  return (
    <p className="meter">
      rows loaded {loaded} · born since open {arrivals} · goals on air {goals} · card renders{' '}
      {cellRenders}
    </p>
  )
}

function Rail(): ReactNode {
  const name = useLive(() => app.shelf.get())
  const shelfView = app.shelves[name]
  const size = useLive(() => shelfView.size.get())

  const box = useRef<HTMLDivElement>(null)
  const frame = useRef(0)
  const [first, setFirst] = useState(0)
  const [height, setHeight] = useState(600)

  useEffect(() => {
    const view = box.current
    if (view === null) return
    const measure = (): void => setHeight(view.clientHeight)
    measure()
    const watcher = new ResizeObserver(measure)
    watcher.observe(view)
    return () => {
      watcher.disconnect()
      if (frame.current !== 0) cancelAnimationFrame(frame.current)
    }
  }, [])

  const span = Math.ceil(height / ROW) + OVERSCAN * 2

  // Reporting the look is the only "effect" here; the pages follow on their own.
  useEffect(() => {
    app.reach.set(first + span)
  }, [first, span])

  const onScroll = (): void => {
    if (frame.current !== 0) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const view = box.current
      if (view === null) return
      const wanted = Math.max(0, Math.floor(view.scrollTop / ROW) - OVERSCAN)
      setFirst(was => (was === wanted ? was : wanted))
    })
  }

  const rows = useLive(() => shelfView.slice(first, first + span).get())

  // The list is alive: games are born and leave above the window, and every such
  // move shifts the indices the window is positioned by. The library holds the
  // top drawn row in place; switching shelves forgets it.
  useKeepRow({
    box,
    rowHeight: ROW,
    first,
    rows,
    keyOf: (g: Game) => g.id,
    rankOf: key => shelfView.rank(key),
    reset: name,
  })

  return (
    <div className="stack" ref={box} onScroll={onScroll}>
      <div style={{ height: size * ROW, position: 'relative' }}>
        <div style={{ position: 'absolute', top: first * ROW, left: 0, right: 0 }}>
          {rows.map(g => (
            <Card key={g.id} id={g.id} />
          ))}
        </div>
      </div>
    </div>
  )
}

export function App(): ReactNode {
  const picked = useLive(() => app.picked.get())
  const [waves, setWaves] = useState(false)
  return (
    <div className="rail">
      <header className="bar">
        <h1>Rail on weft</h1>
        <nav className="tabs">
          {SHELVES.map(name => (
            <Tab key={name} name={name} />
          ))}
        </nav>
        <Search />
        <Meter />
        <button className="tab" onClick={() => setWaves(w => !w)}>
          waves
        </button>
      </header>
      <Rail />
      {picked !== null && <Details id={picked} />}
      {waves && (
        <WavesPanel inspect={[app.searchText, app.goals, app.counts.live, app.counts.all]} />
      )}
    </div>
  )
}
