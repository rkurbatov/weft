// Arrangement: the ordered-lists-by-lane shape that boards, playlists and
// queues all share. The verbs below are the whole vocabulary an applier
// needs — absolute, total, void and idempotent by construction, so a replay
// on any base is safe. Untouched lanes keep their identity.
//
// Beside the outbox, not in the foundation. These verbs depend on nothing,
// which is why they sat at the bottom of the stack for a while — but that is
// a rule about dependencies, not a statement of kinship. Their subject is an
// intent replayed over a base, and their two callers are the outbox's
// projection and the dialect's overlay. A layer holds what belongs together,
// not everything that happens to fit under it.

import type { Key } from '#feed'

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
  // Asked about first, cleared after. Dropping and then finding no target
  // made "the move is void" mean the subject vanished from the lane it was
  // standing in — a lost card, from a lane name that arrived a moment late.
  if (lanes[into] === undefined) return lanes
  const cleared = laneDrop(lanes, id)
  const lane = cleared[into] as readonly K[]
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
