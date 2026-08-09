// The surface, kept as a type across the wire.
//
// A station declares what it offers and the other side asks for it by name.
// Those names and their types are known at the moment of declaring — and were
// thrown away one line later, because a mirror is asked for as
// `derived<number>('seats')`: a string the compiler cannot check and a type the
// caller states again by hand. Rename a cell on the station and every screen
// keeps compiling and starts returning undefined at runtime.
//
// Nothing here changes what crosses. `faced` only remembers the surface's type
// and hands it back on the other side, so a name that is not offered is a
// compile error and a value that is offered arrives already typed. The station
// side is unchanged; this is what the watcher side was missing.

import type { Watchable } from '#graph'
import type { Remote } from '#remote'
import type { Link, Mirrored, Surface } from './contract.ts'

/** What a cell of the surface holds, seen from the other side. */
type Held<C> = C extends Watchable<infer T> ? T : never

/**
 * What a table of the surface carries, row by row.
 *
 * A surface asks for tables as the least a table must be — a thing with a name
 * — so that a station never casts its own. That leaves the row type to be read
 * back off whichever shape the declaration actually had.
 */
type Rows<T> = T extends { all: Watchable<readonly (infer R)[]> }
  ? R
  : T extends { rows: Watchable<readonly (infer R)[]> }
    ? R
    : unknown

type CellsOf<S extends Surface> = S['cells'] extends infer C
  ? { readonly [K in keyof C]: Watchable<Remote<Held<C[K]>>> }
  : never

type CommandsOf<S extends Surface> = S['commands'] extends infer C
  ? {
      readonly [K in keyof C]: C[K] extends (...args: infer A) => infer T
        ? (...args: A) => Promise<Awaited<T>>
        : never
    }
  : never

type TablesOf<S extends Surface> = S['tables'] extends infer T
  ? { readonly [K in keyof T]: Mirrored<Rows<T[K]>> }
  : never

/**
 * The mirror of a declared surface, with its names and types intact.
 *
 * Read a cell that the station does not offer and it will not compile; read one
 * it does and the answer is already the right shape, without stating it again.
 */
export interface Faced<S extends Surface> {
  readonly cells: CellsOf<S>
  readonly commands: CommandsOf<S>
  readonly tables: TablesOf<S>
  /** The untyped link underneath, for names built at runtime. */
  readonly link: Link
  close(): void
}

/**
 * Put the station's own surface type over a link.
 *
 * The surface is passed as a type, not a value: the declaration lives on the
 * station's side of the wire, and shipping it across would mean shipping its
 * closures. `faced<typeof surface>(link(channel))` is the whole use.
 */
export function faced<S extends Surface>(wire: Link): Faced<S> {
  const cells = new Proxy({}, { get: (_t, name: string) => wire.derived(name) }) as CellsOf<S>
  const commands = new Proxy({}, { get: (_t, name: string) => wire.command(name) }) as CommandsOf<S>
  const tables = new Proxy({}, { get: (_t, name: string) => wire.table(name) }) as TablesOf<S>

  return {
    cells,
    commands,
    tables,
    link: wire,
    close: () => wire.close(),
  }
}
