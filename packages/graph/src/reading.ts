// Who is reading right now.
//
// A property of the call stack, not of an engine: a formula of one engine can
// reach for a node of another, and that reach is exactly what has to be
// refused. So the reader is tracked per isolate, and the engines are compared
// at the moment the link is made.

import type { Consumer, Node } from './parts.ts'

/**
 * Who is reading right now is a property of the call stack, not of an engine:
 * a formula of one engine can reach for a node of another, and that reach is
 * exactly what has to be refused. So the reader is tracked per isolate, and
 * the engines are compared at the moment of the link.
 */
let active: Consumer | null = null
let tracking: Set<Node> | null = null

export function observe(source: Node): void {
  const consumer = active
  if (consumer === null) return
  // The boundary check, at the one gate every read passes. Several engines
  // can live in one isolate — one per session behind a shared worker — and a
  // formula reaching into another engine through a closure would quietly
  // stitch the two graphs together: its subscription would pin foreign nodes
  // past their session's teardown, and its recomputes would leak one
  // session's data into another's. Thrown here, at the read, the mistake
  // names both engines while the stack still shows who reached; the one
  // lawful bridge between engines is `adopt`, which carries values, not
  // edges.
  if (source.engine !== consumer.engine) throw crossing(consumer, source)
  if (consumer.sources.has(source)) return
  consumer.sources.add(source)
  // A link that survives a recompute keeps its observer slot and its demand.
  if (tracking !== null && tracking.delete(source)) return
  source.observers.add(consumer)
  const carried = consumer.contribution()
  if (carried > 0) source.demandChanged(carried)
}

/** Read without becoming dependent on it. */
export function untracked<T>(fn: () => T): T {
  const prevActive = active
  const prevTracking = tracking
  active = null
  tracking = null
  try {
    return fn()
  } finally {
    active = prevActive
    tracking = prevTracking
  }
}

function crossing(reader: Consumer, source: Node): Error {
  return new Error(
    `weft: "${reader.name}" in engine "${reader.engine.name}" read "${source.name}", ` +
      `which lives in engine "${source.engine.name}". Engines do not read each other; ` +
      `publish from a shared engine and adopt it instead.`,
  )
}

// ── The registry ─────────────────────────────────────────────────────────────

/** The consumer whose run we are inside, if any. */
export const reader = (): Consumer | null => active

/** Run a body as this consumer, keeping the links it reads again. */
export function asReader<T>(node: Consumer, previous: Set<Node>, body: () => T): T {
  const wasActive = active
  const wasTracking = tracking
  active = node
  tracking = previous
  try {
    return body()
  } finally {
    active = wasActive
    tracking = wasTracking
  }
}
