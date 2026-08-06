// Where the engine lives, and how it is replaced.
//
// A Worker is already a wire — it posts and it listens — so it goes into
// `overWire` with no casting. Swap these lines for a direct `engine()` call
// and the panel does not change by a character.
//
// The station sits in a cell, and the panel reads the station from that cell
// rather than being handed one. That is what makes the kill button work: a
// new worker is a new value, so everything that reads through the cell
// recomputes and re-subscribes by the ordinary rules. Handed in as a prop
// instead, a screen keeps watching the mirrors of a worker that no longer
// exists — which looks exactly like "it stopped working".

import type { ReactNode } from 'react'
import { adopt, cell, overWire } from '#loom'
import type { Adopted } from '#loom'
import { mount } from '#demo/mount.tsx'
import { App } from './App.tsx'
import './engine.css'

interface Station {
  readonly engine: Adopted
  readonly stop: () => void
}

function start(): Station {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  const engine = adopt(overWire(worker))
  return {
    engine,
    stop: () => {
      engine.close()
      worker.terminate()
    },
  }
}

// Module state, not effect state: the world outlives a tab's renders, and the
// double mount of strict mode must not raise a second worker.
export const station = cell<Station>(start(), { name: 'station' })

/** Kill the worker, raise another, and tell it what the panel already knows. */
export function replace(pattern: string): void {
  station.peek().stop()
  const fresh = start()
  fresh.engine.write('needle', pattern)
  station.set(fresh)
}

function Root(): ReactNode {
  return <App />
}

mount(<Root />)
