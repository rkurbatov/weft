// The sheet's living side, and how a tab comes to hold it.
//
// Every tab watches the sheet the same way — mirrors over the tab bus — and
// does not know whether it is also the one computing it. Leading only adds
// work: the lock holder builds the graph and serves whoever is on the bus.
// When that tab closes, the browser frees the lock, the next tab builds the
// sheet afresh and announces itself, and every mirror re-asks on its own.

import { atOnce, busHub, input, leadOrFollow, link, perFrame, serve, webLocks } from '#weft'
import type { Channel, Hub, Lock, Watchable } from '#weft'
import { channelOverBus } from '#weft'
import { createSheet } from '../spreadsheet-weft/sheet.ts'
import { sampleSheet } from '../common/sample.ts'
import type { SheetShape } from '../common/sample.ts'

export interface TabWorld {
  hub: () => Hub
  channel: () => Channel
  lock: Lock
  shape: SheetShape
  /** atOnce in tests, perFrame in a browser. */
  schedule?: (work: () => void) => void
}

/** The browser arrangement: one bus name, web locks, a modest sheet. */
export function browserWorld(): TabWorld {
  return {
    hub: () => busHub('weft-sheet-tabs'),
    channel: () => channelOverBus('weft-sheet-tabs'),
    lock: webLocks(),
    shape: { rows: 30, cols: 8 },
    schedule: perFrame,
  }
}

/** Lead: build the sheet and serve the bus. Returns the way to stop. */
export function leadSheet(world: TabWorld): () => void {
  const sheet = createSheet(sampleSheet(world.shape))
  return world.hub().accept(channel =>
    serve(
      {
        families: { shown: (at: string) => sheet.shown(at) },
        commands: {
          set: (at: string, text: string) => sheet.set(at, text),
          textOf: (at: string) => sheet.text(at),
        },
      },
      channel,
      { schedule: world.schedule ?? atOnce },
    ),
  )
}

/** What every tab does: watch over the bus, and lead when the lock comes. */
export function joinSheet(world: TabWorld) {
  const seen = link(world.channel())
  const role = input<'leading' | 'following'>('following', { name: 'role' })
  const stop = leadOrFollow({
    name: 'weft-sheet-tabs',
    lock: world.lock,
    lead: () => {
      role.set('leading')
      return leadSheet(world)
    },
    follow: () => {
      role.set('following')
      return () => {}
    },
  })
  return {
    seen,
    /** Which side this tab is on — an ordinary cell, watch it like any other. */
    role: role as Watchable<'leading' | 'following'>,
    stop: () => {
      stop()
      seen.close()
    },
  }
}
