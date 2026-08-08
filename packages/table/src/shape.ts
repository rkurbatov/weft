// What a table is, said once: the words its own parts speak to each other and
// the words it offers outward. Kept apart from the machinery because five
// files here implement pieces of the same contract, and a contract read from
// inside one implementation is a contract nobody reads.
import type { Key } from '#data'
import type { Equal, Watchable } from '#graph'

export type { Key }

/** One key's move: insert (no prev), update (both sides), removal (no next). */
export interface Change<R> {
  key: Key
  prev?: R
  next?: R
}

export interface Patch<R> {
  put?: readonly R[]
  drop?: readonly Key[]
}

export interface FoldSpec<R, A> {
  /** Who keeps the answer: absent or 'auto' lets the library decide by rule
   *  (see core/plan.ts); set by hand for tests and tuning. */
  carrier?: 'auto' | 'running' | 'tree' | 'oracle'
  zero: A
  add(acc: A, row: R): A
  /** Two partial answers into one — associative. With it (and no inverse) the
   *  fold may be carried as a tree of blocks: one edit recounts one block. */
  join?: (a: A, b: A) => A
  /** Undo one row. With it an edit costs O(1); without it the fold recounts. */
  sub?(acc: A, row: R): A
  equal?: Equal<A>
}

export interface Ordered<R> {
  readonly size: Watchable<number>
  /** Rows [from, to) in order. The same window is the same cell. */
  slice(from: number, to: number): Watchable<readonly R[]>
  /** Where this key stands right now, -1 when absent. Plain and untracked:
   *  made for scroll anchoring, not for formulas. */
  rank(key: Key): number
  dispose(): void
}

export interface Table<R> {
  readonly name: string
  readonly size: Watchable<number>
  /** Every row, insertion-ordered. The honest slow path; prefer views and folds. */
  readonly all: Watchable<readonly R[]>
  /** The cell for one row; wakes only when that row moves. */
  row(key: Key): Watchable<R | undefined>
  where(test: (row: R) => boolean, name?: string): Table<R>
  /** The same, with a predicate that is itself a formula: whatever it reads —
   *  a search field, a chosen status — re-filters the view when it changes. */
  whereLive(pick: () => (row: R) => boolean, name?: string): Table<R>
  orderBy(compare: (a: R, b: R) => number, name?: string): Ordered<R>
  fold<A>(spec: FoldSpec<R, A>, name?: string): Watchable<A>
  count(test?: (row: R) => boolean): Watchable<number>
  sumBy(measure: (row: R) => number): Watchable<number>
  dispose(): void
}

export interface SourceTable<R> extends Table<R> {
  /** One batch, one version step; a put equal to what is there is not a change. */
  apply(patch: Patch<R>): void
  /**
   * Put rows in, one batch, one version step.
   *
   * Takes them loose or as one iterable: `put(a, b)` for a couple, `put(rows)`
   * for a collection. Not rest-only, because rest invites `put(...rows)`, and
   * spreading a hundred thousand rows into call arguments overflows the stack
   * — in a browser, where the stack is smaller than Node's, so tests stay
   * green while the page dies on load. That has happened here.
   */
  put(...rows: readonly R[] | [Iterable<R>]): void
  drop(...keys: readonly Key[] | [Iterable<Key>]): void
  /** The whole picture anew — pages and snapshots land here. Kept rows keep their identity. */
  replace(rows: Iterable<R>): void
  has(key: Key): boolean
  peek(key: Key): R | undefined
}

export interface TableOptions<R> {
  key(row: R): Key
  name?: string
  /** What counts as the same row. Structural by default. */
  equal?: Equal<R>
  /**
   * Who stands when two writers bring the same key: an incoming row that does
   * not win is dropped without a trace. This is how a page that travelled
   * slowly loses to the live event that overtook it. Absent, incoming wins.
   */
  wins?(incoming: R, standing: R): boolean
  /** Change batches remembered for followers; an older follower rebuilds instead. */
  keep?: number
  /** First live watcher arrived — anywhere downstream. Time to feed the table. */
  onDemand?: () => void
  /** Last live watcher left. Whatever feeds the table may rest. */
  onIdle?: () => void
}

// What a derived thing needs from what it follows. State reads are only valid
// after reading version: the read is what brings the follower up to date.
export interface Feed<R> {
  readonly name: string
  readonly version: Watchable<number>
  keyOf(row: R): Key
  get(key: Key): R | undefined
  each(fn: (row: R) => void): void
  count(): number
  /**
   * The rows as the map they already are, read-only and live.
   *
   * For a consumer that needs the whole collection at once — a relational
   * rebuild, a served snapshot. Walking `each` into a fresh map copied a
   * hundred thousand entries to hand over what the table was holding in
   * exactly that shape; the reference is live, so take it for a synchronous
   * look and copy only what outlives the call.
   */
  asMap(): ReadonlyMap<Key, R>
  /** Changes after the given version, or null when they are no longer remembered. */
  changesSince(v: number): Change<R>[] | null
}

export interface Follower<R> {
  first(): void
  apply(changes: readonly Change<R>[]): void
  resync(): void
}
