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
