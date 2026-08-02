// The screen. Components read cells and report what they look at — that is all.
// The window is a cell of the ordered shelf; a card reads its own row and wakes
// alone when its score moves. The render counter in the bar is the proof.

import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { together } from '#weft'
import { useCell, useInputBinding, useSource } from '#weft/react'
import { WavesPanel } from '../common/waves.tsx'
import { countCellRender, useCounters } from '../common/stats.ts'
import { railServer } from './server.ts'
import { rail } from './state.ts'
import type { Shelf } from './state.ts'

const app = rail(railServer())

const ROW = 58
const OVERSCAN = 6
const SHELVES: Shelf[] = ['all', 'live', 'upcoming', 'final']

const clock = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })

const Card = memo(function Card({ id }: { id: number }): ReactNode {
  countCellRender()
  const game = useCell(app.games.row(id))
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
  const picked = useCell(app.shelf) === name
  const count = useCell(app.counts[name])
  return (
    <button className={picked ? 'tab on' : 'tab'} onClick={() => app.shelf.set(name)}>
      {name} <b>{count}</b>
    </button>
  )
}

function Search(): ReactNode {
  const box = useInputBinding(app.searchText) // the two-way seam, spread and done
  const text = box.value.trim()
  return (
    <span className="search">
      <input placeholder="find a team" {...box} />
      {text.length >= 2 && <Matches text={text} />}
    </span>
  )
}

function Matches({ text }: { text: string }): ReactNode {
  // The calm in the passport means the churn of typing asks once; the flat
  // fields of Remote mean the old list keeps showing while the new travels.
  const found = useSource(app.find(text))
  return (
    <span className="matches">
      {found.loading && <span className="dim">…</span>}
      {(found.value ?? []).slice(0, 6).map(game => (
        <button key={game.id} onClick={() => app.picked.set(game.id)}>
          {game.home} — {game.away}
        </button>
      ))}
      {found.value !== undefined && found.value.length === 0 && <span className="dim">nobody</span>}
    </span>
  )
}

function Details({ id }: { id: number }): ReactNode {
  // Two services answer at their own pace; `together` is the whole story of
  // both: value when both hold, in flight while either travels, the first
  // refusal speaking for the pair.
  const info = useSource(app.gameInfo(id))
  const odds = useSource(app.gameOdds(id))
  const game = useCell(app.games.row(id))
  const both = together({ info, odds })
  return (
    <aside className="details">
      <header>
        <b>{game === undefined ? `game ${id}` : `${game.home} — ${game.away}`}</b>
        <button onClick={() => app.picked.set(null)}>×</button>
      </header>
      {both.loading && both.value === undefined && <p className="dim">asking two services…</p>}
      {both.value !== undefined && (
        <p>
          {both.value.info.venue} · {both.value.info.attendance.toLocaleString()} seats
          <br />
          odds {both.value.odds.h.toFixed(2)} / {both.value.odds.x.toFixed(2)} /{' '}
          {both.value.odds.a.toFixed(2)}
        </p>
      )}
      {both.error !== undefined && <p className="gate">{String(both.error)}</p>}
    </aside>
  )
}

function Meter(): ReactNode {
  const { cellRenders } = useCounters()
  const goals = useCell(app.goals)
  const loaded = useCell(app.loaded)
  const arrivals = useCell(app.arrivals)
  return (
    <p className="meter">
      rows loaded {loaded} · born since open {arrivals} · goals on air {goals} · card renders{' '}
      {cellRenders}
    </p>
  )
}

function Rail(): ReactNode {
  const name = useCell(app.shelf)
  const shelfView = app.shelves[name]
  const size = useCell(shelfView.size)

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

  const rows = useCell(shelfView.slice(first, first + span))

  // The list is alive: games are born and leave above the window, and every
  // such move shifts the indices the window is positioned by. The anchor keeps
  // the top drawn row at the same pixel; the scroll event then catches `first`
  // up, and the overscan covers the frame in between.
  const anchor = useRef<{ key: number; rank: number; shelf: Shelf } | null>(null)
  useLayoutEffect(() => {
    const held = anchor.current
    if (held !== null && held.shelf === name) {
      const stands = shelfView.rank(held.key)
      if (stands >= 0 && stands !== held.rank) {
        const view = box.current
        if (view !== null) view.scrollTop += (stands - held.rank) * ROW
        anchor.current = { ...held, rank: stands }
        return // the same anchor, restated
      }
    }
    const top = rows[0]
    anchor.current = top === undefined ? null : { key: top.id, rank: first, shelf: name }
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
  const picked = useCell(app.picked)
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
      {waves && <WavesPanel />}
    </div>
  )
}
