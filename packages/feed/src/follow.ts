// The change log and the way to follow it.
//
// A follower that arrives late, or one that fell behind further than the log
// remembers, is told to rebuild rather than handed a hole — falling behind is
// an event with a name, not a silence.
import type { Change, Feed, Follower } from './shape.ts'

/** What the log promises: keep a batch by version, and answer what came after. */
export interface ChangeLog<R> {
  push(v: number, changes: Change<R>[]): void
  since(v: number, current: number): Change<R>[] | null
}

export const KEEP = 64

export function changeLog<R>(keep: number): ChangeLog<R> {
  const batches: Array<{ v: number; changes: Change<R>[] }> = []
  return {
    push(v, changes) {
      batches.push({ v, changes })
      while (batches.length > keep) batches.shift()
    },
    since(v, current) {
      if (v === current) return []
      const oldest = batches[0]
      if (oldest === undefined || v < oldest.v - 1) return null
      const out: Change<R>[] = []
      // Not `push(...b.changes)`: a batch has no size limit, and spreading one
      // into call arguments overflows the stack. The same mistake, in the same
      // shape, has now been made three times in this repository.
      for (const b of batches) {
        if (b.v <= v) continue
        for (const change of b.changes) out.push(change)
      }
      return out
    },
  }
}

/** The one pattern every derived thing shares: build once, then eat changes. */
export function follow<R>(feed: Feed<R>, on: Follower<R>): () => void {
  let started = false
  let seen = 0
  return () => {
    const now = feed.version.get()
    if (!started) {
      started = true
      on.first()
      seen = now
      return
    }
    if (now === seen) return
    const changes = feed.changesSince(seen)
    if (changes === null) on.resync()
    else if (changes.length > 0) on.apply(changes)
    seen = now
  }
}
