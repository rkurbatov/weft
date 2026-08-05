// A region owns a piece of the graph. Everything created while it builds —
// cells, watchers, sources, outboxes — is remembered and let go in one move,
// in reverse order of birth. Regions nest; names nest with them, so a cell
// born inside region "kanban" carries "kanban." on its name.
//
// The region is what makes a module of the store autonomous: it can be raised,
// used, and taken down whole, with nothing left ticking behind it.
//
// A region is a resident of an engine, not a second owner of life beside it:
// the functions here work on the engine a bare build would use, and an engine
// takes down the regions it holds.

import { coreForBuild } from './engine.ts'
import type { RegionOf } from './engine.ts'

export type Region<T> = RegionOf<T>

/** Give the enclosing region something to let go of. No region — the engine keeps it. */
export function owned(teardown: () => void): void {
  coreForBuild().owned(teardown)
}

/** The name prefix of the enclosing region, if any. */
export function regionName(): string | undefined {
  return coreForBuild().regionName()
}

export function region<T>(name: string, build: () => T): Region<T> {
  return coreForBuild().region(name, build)
}
