// The compiler is the test here.
//
// `@ts-expect-error` fails the build if the line below it turns out to be
// legal — so this file passing type-check is the assertion: a name the station
// never offered does not compile, and a command keeps the arguments it was
// declared with. Nothing runs; there is nothing to run.

import { test } from 'node:test'
import { faced, link, serve } from '#link'
import { wirePair } from '#wire'
import { port } from '#weft'

test('a surface that does not offer a name does not compile against it', () => {
  const seats = port(1, { name: 'typed.types.seats' })
  const surface = { cells: { seats }, commands: { take: (many: number): number => many } }
  const pair = wirePair()
  const stop = serve(surface, pair.graph)
  const station = faced<typeof surface>(link(pair.watcher))

  // Assigned rather than left standing: an expression on its own is a lint
  // error, and the point is what the compiler makes of the right-hand side.
  const offered = station.cells.seats
  // @ts-expect-error — the station never offered this one
  const missing = station.cells.chairs
  // @ts-expect-error — declared taking a number
  const wrongArgument = station.commands.take('two')
  void offered
  void missing
  void wrongArgument

  station.close()
  stop()
})
