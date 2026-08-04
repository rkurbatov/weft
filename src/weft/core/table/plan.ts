// The empirics live here and nowhere else: given what is known about a fold —
// how big the collection is, what the operation can do — pick the carrier that
// keeps it. The rest of the library asks this module and does not reason.
//
// Kept apart on purpose: today the choice is a rule of thumb; a planner that
// measures, or re-plans as a collection grows, replaces this file without
// touching a fold's code or anyone's application.

export type Carrier = 'running' | 'tree' | 'recount'

export interface FoldTraits {
  /** Rows in the collection when the fold is built. */
  size: number
  /** The operation can undo one row (an inverse exists). */
  hasSub: boolean
  /** Two partial answers combine (associative join over accumulators). */
  hasJoin: boolean
  /** Forced by hand — tests and tuning; 'auto' or absent asks the rule. */
  forced?: Carrier | 'auto'
}

export interface Plan {
  carrier: Carrier
  /** Why — one line, for the instruments. A decision nobody can see is magic. */
  reason: string
}

/** Under this many rows a recount is cheaper than any structure's upkeep. */
export const TREE_WORTH_IT = 256
/** Rows per block when a tree carries the fold. Measured on the sheet: the
 *  optimum sat nearer 512 than 32. */
export const TREE_SPAN = 512

const listeners = new Set<(name: string, plan: Plan) => void>()

/** The instruments' door: every decision is announced here. */
export function onPlan(listener: (name: string, plan: Plan) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** A scan's carrier: a prefix line of plain numbers, or an honest recount of
 *  the tail from the edit. The same door, the same announcement. */
export type ScanCarrier = 'offsets' | 'tail'

export interface ScanTraits {
  /** Rows in the ordered view when the scan is built. */
  size: number
  /** The carry is a number added along — the only shape a prefix line holds. */
  numeric: boolean
  forced?: ScanCarrier | 'auto'
}

export interface ScanPlan {
  carrier: ScanCarrier
  reason: string
}

const scanListeners = new Set<(name: string, plan: ScanPlan) => void>()

export function onScanPlan(listener: (name: string, plan: ScanPlan) => void): () => void {
  scanListeners.add(listener)
  return () => scanListeners.delete(listener)
}

export function planScan(name: string, traits: ScanTraits): ScanPlan {
  const plan = decideScan(traits)
  for (const listener of scanListeners) listener(name, plan)
  return plan
}

function decideScan(traits: ScanTraits): ScanPlan {
  if (traits.forced !== undefined && traits.forced !== 'auto') {
    if (traits.forced === 'offsets' && !traits.numeric) {
      throw new Error("weft: an 'offsets' carrier needs a numeric carry — it adds along a line")
    }
    return { carrier: traits.forced, reason: 'forced by the passport' }
  }
  if (!traits.numeric) {
    return { carrier: 'tail', reason: 'the carry is not a number: only a tail recount is lawful' }
  }
  if (traits.size >= TREE_WORTH_IT) {
    return {
      carrier: 'offsets',
      reason: `a numeric carry over ${traits.size} rows: a point update, not a tail`,
    }
  }
  return {
    carrier: 'tail',
    reason: `only ${traits.size} rows: walking the tail is cheaper than a line's upkeep`,
  }
}

export function planFold(name: string, traits: FoldTraits): Plan {
  const plan = decide(traits)
  for (const listener of listeners) listener(name, plan)
  return plan
}

function decide(traits: FoldTraits): Plan {
  if (traits.forced !== undefined && traits.forced !== 'auto') {
    if (traits.forced === 'tree' && !traits.hasJoin) {
      throw new Error("weft: a 'tree' carrier needs a join — two partial answers must combine")
    }
    return { carrier: traits.forced, reason: 'forced by the passport' }
  }
  if (traits.hasSub) {
    return { carrier: 'running', reason: 'an inverse exists: one edit is one add and one sub' }
  }
  if (traits.hasJoin && traits.size >= TREE_WORTH_IT) {
    return {
      carrier: 'tree',
      reason: `no inverse and ${traits.size} rows: recount one block, not the collection`,
    }
  }
  return {
    carrier: 'recount',
    reason: traits.hasJoin
      ? `no inverse and only ${traits.size} rows: a recount is cheaper than a tree's upkeep`
      : 'no inverse and no join: nothing but a recount is lawful',
  }
}
