import { notice } from '#graph'
// The empirics live here and nowhere else: given what is known about a fold —
// how big the collection is, what the operation can do — pick the carrier that
// keeps it. The rest of the library asks this module and does not reason.
//
// Kept apart on purpose: today the choice is a rule of thumb; a planner that
// measures, or re-plans as a collection grows, replaces this file without
// touching a fold's code or anyone's application.
//
// The scan plan lives here too, although scan itself is the relational
// layer's word. Deliberate, not a leak: the empirics have one home, and the
// dependency still points the right way — rel asks table, never the
// reverse. Split by layer, the fold's thresholds and the scan's would drift
// apart in two files nobody reads together.

export type Carrier = 'running' | 'tree' | 'oracle'

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

/** Under this many rows a oracle is cheaper than any structure's upkeep. */
export const TREE_WORTH_IT = 256
/** Rows per block when a tree carries the fold. Measured on the sheet: the
 *  optimum sat nearer 512 than 32. */
export const TREE_SPAN = 512

/** A scan's carrier: a prefix line of plain numbers, or an honest oracle of
 *  the tail from the edit. The same door, the same announcement. */
export type ScanCarrier = 'offsets' | 'tail'
/** Where the carry lives: written into every row, or answered when asked.
 *  Port is what a ledger's balance column wants — a short list where the
 *  running total is shown. Asked is what a virtualised list wants: an edit
 *  near the top must not rewrite the tail. */
export type ScanForm = 'stored' | 'asked'

export interface ScanTraits {
  /** Rows in the ordered view when the scan is built. */
  size: number
  /** The carry is a number added along — the only shape a prefix line holds. */
  numeric: boolean
  /** The tree names a carry field: the application asked to see it per row. */
  named: boolean
  forced?: ScanCarrier | 'auto'
}

export interface ScanPlan {
  carrier: ScanCarrier
  form: ScanForm
  reason: string
}

/** Above this many rows, writing a carry into every row costs more than the
 *  screen that reads it — measured on the list bench, where a stored carry
 *  ran three orders behind an asked one on the very first edit. */
export const STORED_CARRY_LIMIT = 4096

export function planScan(name: string, traits: ScanTraits): ScanPlan {
  const plan = decideScan(traits)
  notice({
    kind: 'scan-plan',
    where: name,
    level: traits.named && traits.size >= STORED_CARRY_LIMIT ? 'warn' : 'note',
    message: `the scan "${name}" is carried by ${plan.carrier}, its carry ${plan.form}: ${plan.reason}`,
    detail: { carrier: plan.carrier, form: plan.form, reason: plan.reason, ...traits },
  })
  return plan
}

function decideScan(traits: ScanTraits): ScanPlan {
  // The form is not the planner's to take away. A named carry is a field the
  // builder's type promises on every row; the plan used to drop it past the
  // limit, and the rows then lied against their own type — correct under
  // 4096 rows in a test, `undefined` in production the day the table grew.
  // An optimiser may choose HOW to answer, never WHAT: naming no field asks
  // for the cheap form, naming one buys the field at its price — and past
  // the limit the price is announced as a warning rather than paid silently.
  const form: ScanForm = traits.named ? 'stored' : 'asked'
  const dear = traits.named && traits.size >= STORED_CARRY_LIMIT
  const why = !traits.named
    ? 'no carry field named: nothing to write into rows'
    : dear
      ? `${traits.size} rows: the named carry is kept, though it rewrites the tail on every ` +
        `edit — leave the field unnamed and read the view's offsetOf to trade it away`
      : `${traits.size} rows: writing the carry into rows is still cheap`

  if (traits.forced !== undefined && traits.forced !== 'auto') {
    if (traits.forced === 'offsets' && !traits.numeric) {
      throw new Error("weft: an 'offsets' carrier needs a numeric carry — it adds along a line")
    }
    return { carrier: traits.forced, form, reason: `forced by the passport; ${why}` }
  }
  if (!traits.numeric) {
    return {
      carrier: 'tail',
      form,
      reason: `the carry is not a number: only a tail oracle is lawful; ${why}`,
    }
  }
  if (traits.size >= TREE_WORTH_IT) {
    return {
      carrier: 'offsets',
      form,
      reason: `a numeric carry over ${traits.size} rows: a point update, not a tail; ${why}`,
    }
  }
  return {
    carrier: 'tail',
    form,
    reason: `only ${traits.size} rows: walking the tail is cheaper than a line's upkeep; ${why}`,
  }
}

export function planFold(name: string, traits: FoldTraits): Plan {
  const plan = decide(traits)
  notice({
    kind: 'fold-plan',
    where: name,
    level: 'note',
    message: `the fold "${name}" is kept by ${plan.carrier}: ${plan.reason}`,
    detail: { carrier: plan.carrier, reason: plan.reason, ...traits },
  })
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
      reason: `no inverse and ${traits.size} rows: oracle one block, not the collection`,
    }
  }
  return {
    carrier: 'oracle',
    reason: traits.hasJoin
      ? `no inverse and only ${traits.size} rows: a oracle is cheaper than a tree's upkeep`
      : 'no inverse and no join: nothing but a oracle is lawful',
  }
}
