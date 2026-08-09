// A station and a watcher joined by a wire, torn down with the test.
//
// The shape it replaces, spelled out in every wire test: make a pair, serve
// the surface on one end with an immediate schedule, link the other, remember
// to stop both. Anything a test builds on top — tables, mirrors, subscriptions
// — stays the test's own business; this is only the plumbing that was the
// same every time.

import { link, serve } from '#link'
import type { ServeOptions, Surface } from '#link'
import { atOnce, wirePair } from '#wire'
import { closing, until } from './lifetime.ts'

export function setupWire(
  surface: Surface,
  options: ServeOptions = {},
): { watcher: ReturnType<typeof link>; wire: ReturnType<typeof wirePair> } {
  const wire = wirePair()
  until(serve(surface, wire.graph, { schedule: atOnce, ...options }))
  const watcher = closing(link(wire.watcher))
  // The pair comes back too: a test that pokes the channel itself — sending
  // nonsense down it, counting what crosses — needs the ends, and having to
  // build the whole thing by hand for that is what this file exists against.
  return { watcher, wire }
}
