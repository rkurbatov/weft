// Where the engine lives is one decision, made here and nowhere else.
//
// A Worker is already a wire — it posts messages and listens for them — so it
// goes straight into `overWire` with no casting. Swap these five lines for a
// direct `engine()` call and the panel above does not change by a character:
// that is the claim this page exists to test.

import { useState } from 'react'
import type { ReactNode } from 'react'
import { adopt, overWire } from '#loom'
import type { Adopted } from '#loom'
import { mount } from '#demo/mount.tsx'
import { App } from './App.tsx'
import './engine.css'

interface Running {
  readonly engine: Adopted
  readonly stop: () => void
}

function start(): Running {
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
let running = start()

function Root(): ReactNode {
  const [, redraw] = useState(0)
  return (
    <App
      engine={running.engine}
      restart={pattern => {
        running.stop()
        running = start()
        // The new engine starts empty, as a new engine would. What the panel
        // knows, it says again — the same write it would make on any keystroke.
        running.engine.write('needle', pattern)
        redraw(n => n + 1)
      }}
    />
  )
}

mount(<Root />)
