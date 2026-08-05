// oxlint-disable oxc/no-map-spread -- assembly builds a new picture; identity of
// untouched pieces is restored by preserve, not by mutating the old one.
// The laying: visible = truth + the replay of the book. Rules are written in
// the verbs of a resolution builder — b is not a draft and not arrays:
// take(id) — "this does not exist", place(id, into, at) — "wherever it was,
// it counts here", put(row) — "the subject exists". The laws of the
// applicator are properties of the assembly: absoluteness and totality are
// the meaning of place; idempotence — the last resolution per subject wins;
// voidness — an unresolvable subject assembles into nothing, so no guards are
// written in rules. Book order is the law of assembly between subjects.
// A rule of application is a property of the picture, not of the note: one
// will may lay over any number of truths, each absorbing what concerns it.

import { derived, watch } from '#weft'
import type { Watchable } from '#weft'
import { laneDrop, lanePlace } from '#weft'
import type { Lanes } from '#weft'
import { preserve } from '#weft'
import type { Note } from '#weft'

export interface Lane {
  readonly id: string
  readonly items: readonly string[]
}

export interface Board<R> {
  readonly rows: ReadonlyMap<string, R>
  readonly lanes: readonly Lane[]
}

export interface Builder<R> {
  /** Wherever it stands — it counts in `into` at `at` ('end' for the tail). */
  place(id: string, into: string, at: number | 'end'): Builder<R>
  /** This does not exist. */
  take(id: string): Builder<R>
  /** The subject exists. */
  put(row: R): Builder<R>
}

export interface LaidShape<S, R> {
  rows: (s: S) => readonly R[]
  key: (r: R) => string
  lanes: (s: S) => readonly Lane[]
}

interface WillSide {
  notes: Watchable<readonly Note[]>
  absorb(before: number): void
}

interface TruthSide<S> {
  get(): S
  asked: Watchable<number>
}

export interface LaidSpec<S, R> {
  shape: LaidShape<S, R>
  rules: Readonly<Record<string, (b: Builder<R>, op: never) => void>>
  name?: string
}

export function laid<S, R>(
  base: TruthSide<S>,
  post: WillSide,
  spec: LaidSpec<S, R>,
): Watchable<Board<R>> {
  const name = spec.name ?? 'laid'

  // Absorption is wired where both sides meet: a snapshot taken after a
  // confirmation absorbs it. Cold watch — reacts to what arrives anyway.
  watch(
    () => {
      const asked = base.asked.get()
      if (asked > 0) post.absorb(asked)
    },
    { demand: false },
  )

  /**
   * The server's picture, on its own. It changes when the server answers —
   * rarely — so this is the one place where a whole map is built and where
   * identity of untouched pieces is restored.
   */
  let lastBase: Board<R> | undefined
  const fromBase = derived<Board<R>>(
    () => {
      const snapshot = base.get()
      const rows = new Map<string, R>()
      for (const row of spec.shape.rows(snapshot)) rows.set(spec.shape.key(row), row)
      const built: Board<R> = {
        rows,
        lanes: spec.shape.lanes(snapshot).map(lane => ({
          ...lane,
          items: lane.items.filter(id => rows.has(id)),
        })),
      }
      const kept = lastBase === undefined ? built : preserve(lastBase, built)
      lastBase = kept
      return kept
    },
    { name: `${name}.base` },
  )

  /**
   * The book laid over it.
   *
   * The rows are not copied. A board of ten thousand cards used to be rebuilt
   * on every local move — every drag, every keystroke — which threw away the
   * whole point of keeping changes small. What is built here is the size of
   * the book: what it put, and what it took away. Everything else is read
   * through to the server's map.
   */
  const seen = derived<Board<R>>(
    () => {
      const under = fromBase.get()
      const notes = post.notes.get()
      if (notes.length === 0) return under

      const placed = new Map<string, R>()
      const gone = new Set<string>()
      let lanes: Lanes<string> | undefined
      const laneItems = (): Lanes<string> => {
        lanes ??= Object.fromEntries(under.lanes.map(lane => [lane.id, lane.items]))
        return lanes
      }

      const b: Builder<R> = {
        place(id, into, at) {
          gone.delete(id)
          lanes = lanePlace(laneItems(), id, into, at === 'end' ? Number.MAX_SAFE_INTEGER : at)
          return b
        },
        take(id) {
          gone.add(id)
          lanes = laneDrop(laneItems(), id)
          return b
        },
        put(row) {
          placed.set(spec.shape.key(row), row)
          return b
        },
      }
      for (const entry of notes) {
        if (entry.state === 'stuck') continue
        spec.rules[entry.name]?.(b, entry.args as never)
      }

      if (placed.size === 0 && gone.size === 0 && lanes === undefined) return under

      const rows = overlay(under.rows, placed, gone)
      const moved = lanes
      const nextLanes = under.lanes.map(lane => {
        // Voidness at assembly: an id with no subject assembles into nothing.
        // Membership is a lookup per id, not a copy of every row — and a lane
        // that did not really change keeps the very array it had, so a screen
        // watching it stays asleep.
        const want = moved?.[lane.id] ?? lane.items
        const items = want.filter(id => rows.has(id))
        return same(items, lane.items) ? lane : { ...lane, items }
      })

      // A book that changed nothing — a resolution about a subject that does
      // not exist — leaves the very board that was there.
      const still =
        placed.size === 0 &&
        gone.size === 0 &&
        nextLanes.every((lane, i) => lane === under.lanes[i])
      return still ? under : { rows, lanes: nextLanes }
    },
    { name },
  )
  return seen
}

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i])

/**
 * The server's rows with a handful laid over them: what the book put, and what
 * it took away. A read looks at the small maps first and falls through to the
 * big one, so nothing is copied to make it.
 */
function overlay<R>(
  under: ReadonlyMap<string, R>,
  placed: ReadonlyMap<string, R>,
  gone: ReadonlySet<string>,
): ReadonlyMap<string, R> {
  const has = (id: string): boolean => (placed.has(id) ? true : !gone.has(id) && under.has(id))
  let size = under.size + placed.size - gone.size
  for (const id of placed.keys()) if (under.has(id) && !gone.has(id)) size--
  for (const id of gone) if (!under.has(id)) size++

  function* walk(): Generator<[string, R], undefined> {
    for (const [id, row] of under) {
      if (gone.has(id) || placed.has(id)) continue
      yield [id, row]
    }
    for (const [id, row] of placed) yield [id, row]
    return undefined
  }
  const entries = (): MapIterator<[string, R]> => walk() as unknown as MapIterator<[string, R]>

  const map: ReadonlyMap<string, R> = {
    get size() {
      return size
    },
    has,
    get: (id: string) =>
      placed.has(id) ? placed.get(id) : gone.has(id) ? undefined : under.get(id),
    keys: () => {
      function* ids(): Generator<string, undefined> {
        for (const [id] of walk()) yield id
        return undefined
      }
      return ids() as unknown as MapIterator<string>
    },
    values: () => {
      function* rows(): Generator<R, undefined> {
        for (const [, row] of walk()) yield row
        return undefined
      }
      return rows() as unknown as MapIterator<R>
    },
    entries,
    forEach(fn: (row: R, id: string, self: ReadonlyMap<string, R>) => void, self?: unknown) {
      for (const [id, row] of walk()) fn.call(self, row, id, map)
    },
    [Symbol.iterator]: entries,
  }
  return map
}
