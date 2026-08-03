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

import { cell, watch } from '#core/graph.ts'
import type { Watchable } from '#core/graph.ts'
import { laneDrop, lanePlace } from '#core/arrange.ts'
import type { Lanes } from '#core/arrange.ts'
import { preserve } from '#core/project.ts'
import type { Entry } from '#core/outbox.ts'

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
  notes: Watchable<readonly Entry[]>
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

  let previous: Board<R> | undefined
  const seen = cell<Board<R>>(
    () => {
      const snapshot = base.get()
      const rows = new Map<string, R>()
      for (const row of spec.shape.rows(snapshot)) rows.set(spec.shape.key(row), row)
      const meta = spec.shape.lanes(snapshot)
      let lanes: Lanes<string> = Object.fromEntries(meta.map(lane => [lane.id, lane.items]))

      // Replay in book order; the builder's verbs are absolute resolutions.
      const placedRows = new Map<string, R>()
      const gone = new Set<string>()
      const b: Builder<R> = {
        place(id, into, at) {
          gone.delete(id)
          lanes = lanePlace(lanes, id, into, at === 'end' ? Number.MAX_SAFE_INTEGER : at)
          return b
        },
        take(id) {
          gone.add(id)
          lanes = laneDrop(lanes, id)
          return b
        },
        put(row) {
          placedRows.set(spec.shape.key(row), row)
          return b
        },
      }
      for (const entry of post.notes.get()) {
        if (entry.state === 'stuck') continue
        const rule = spec.rules[entry.name]
        rule?.(b, entry.args as never)
      }

      for (const [id, row] of placedRows) rows.set(id, row)
      for (const id of gone) rows.delete(id)

      // Voidness at assembly: an id with no subject assembles into nothing.
      const assembled: Board<R> = {
        rows,
        lanes: meta.map(lane => ({
          ...lane,
          items: (lanes[lane.id] ?? []).filter(id => rows.has(id)),
        })),
      }
      const kept = previous === undefined ? assembled : preserve(previous, assembled)
      previous = kept
      return kept
    },
    { name },
  )
  return seen
}
