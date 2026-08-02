// The waves panel: the journal made visible. Every row is one wave — what was
// written, how much recomputed, where it died on equality (the red dot), who
// woke. A dev tool, so it owns the one global probe while mounted.

import { useEffect, useReducer, useState } from 'react'
import type { ReactNode } from 'react'
import { journal } from '#weft'

export function WavesPanel({ limit = 9 }: { limit?: number }): ReactNode {
  const [, bump] = useReducer((x: number) => x + 1, 0)
  const [book] = useState(() => journal(64, () => bump()))

  useEffect(() => {
    book.start()
    return () => book.stop()
  }, [book])

  const tail = book.waves().slice(-limit).reverse()

  return (
    <aside className="waves">
      <header>
        waves <span className="dim">writes → computed · gated · woke · ms</span>
      </header>
      {tail.length === 0 && <p className="dim">quiet — interact with the page</p>}
      {tail.map(wave => (
        <p key={wave.id}>
          <b>#{wave.id}</b> {wave.writes.map(w => w.node).join(', ')}
          {' → '}
          {wave.computed.length}
          {wave.gated.length > 0 && <span className="gate"> ● {wave.gated.join(', ')}</span>}
          {' · woke '}
          {wave.woke}
          {' · '}
          {wave.ms.toFixed(1)}ms
        </p>
      ))}
    </aside>
  )
}
