// A station and a watcher joined by a wire, torn down with the test.
//
// The shape it replaces, spelled out in every wire test: make a pair, serve
// the surface on one end with an immediate schedule, link the other, remember
// to stop both. Anything a test builds on top — tables, mirrors, subscriptions
// — stays the test's own business; this is only the plumbing that was the
// same every time.

import { link, serve } from '#link'
import type { ServeOptions, Surface } from '#link'
import { atOnce, wirePair } from '#link'
import { closing, until } from './lifetime.ts'

export function setupWire(
  surface: Surface,
  options: ServeOptions = {},
): { watcher: ReturnType<typeof link> } {
  const wire = wirePair()
  until(serve(surface, wire.graph, { schedule: atOnce, ...options }))
  const watcher = closing(link(wire.watcher))
  return { watcher }
}
