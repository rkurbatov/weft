// Arrangement: the ordered-lists-by-lane shape that boards, playlists and
// queues all share. The verbs below are the whole vocabulary an applier
// needs — absolute, total, void and idempotent by construction, so a replay
// on any base is safe. Untouched lanes keep their identity.

import type { Key } from '../data/key.ts'

export type Lanes<K extends Key = Key> = Readonly<Record<string, readonly K[]>>

/** Wherever it stands — no longer there. Absent — nothing happens. */
export function laneDrop<K extends Key>(lanes: Lanes<K>, id: K): Lanes<K> {
  let next: Record<string, readonly K[]> | null = null
  for (const name of Object.keys(lanes)) {
    const lane = lanes[name]
    if (lane === undefined || !lane.includes(id)) continue
    next ??= { ...lanes }
    next[name] = lane.filter(x => x !== id)
  }
  return next ?? lanes
}

/** Put it here — wherever it stood before. The intent names the target only. */
export function lanePlace<K extends Key>(
  lanes: Lanes<K>,
  id: K,
  into: string,
  at: number,
): Lanes<K> {
  const cleared = laneDrop(lanes, id)
  const lane = cleared[into]
  if (lane === undefined) return cleared // no such lane: the move is void
  const index = Math.max(0, Math.min(at, lane.length))
  return { ...cleared, [into]: [...lane.slice(0, index), id, ...lane.slice(index)] }
}

/** Place at the end of a lane. */
export function laneAppend<K extends Key>(lanes: Lanes<K>, id: K, into: string): Lanes<K> {
  return lanePlace(lanes, id, into, Number.MAX_SAFE_INTEGER)
}

/** Which lane holds it, and where. */
export function laneFind<K extends Key>(
  lanes: Lanes<K>,
  id: K,
): { lane: string; at: number } | null {
  for (const name of Object.keys(lanes)) {
    const at = lanes[name]?.indexOf(id) ?? -1
    if (at >= 0) return { lane: name, at }
  }
  return null
}
