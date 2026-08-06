// Who is reading right now.
//
// A property of the call stack, not of an engine: a formula of one engine can
// reach for a node of another, and that reach is exactly what has to be
// refused. So the reader is tracked per isolate, and the engines are compared
// at the moment the link is made.

import type { Consumer, Source } from './parts.ts'

/**
 * Who is reading right now is a property of the call stack, not of an engine:
 * a formula of one engine can reach for a node of another, and that reach is
 * exactly what has to be refused. So the reader is tracked per isolate, and
 * the engines are compared at the moment of the link.
 */
let active: Consumer | null = null
let tracking: Set<Source> | null = null

export function track(source: Source): void {
  const consumer = active
  if (consumer === null) return
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

function crossing(reader: Consumer, source: Source): Error {
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
export function asReader<T>(node: Consumer, previous: Set<Source>, body: () => T): T {
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
