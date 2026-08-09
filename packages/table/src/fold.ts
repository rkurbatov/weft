// A fold over a table: the answer, and the carrier that keeps it.
//
// Nothing here decides how to keep it — that is the planner's business, asked
// afresh as the collection grows, and answered by a carrier behind one door.

import { derived } from '#graph'
import type { Derived } from '#graph'
import { carrierFor } from './carriers/index.ts'
import { follow } from '#feed'
import { planFold, TREE_WORTH_IT } from './plan.ts'
import type { FoldTraits } from './plan.ts'
import type { Feed, FoldSpec } from './contract.ts'

export function foldOver<R, A>(feed: Feed<R>, spec: FoldSpec<R, A>, name: string): Derived<A> {
  // The rows a carrier is built over: the feed, seen as little as a carrier
  // needs to see it.
  const rows = {
    each: feed.each.bind(feed),
    keyOf: feed.keyOf.bind(feed),
    count: feed.count.bind(feed),
  }
  const traits = (): FoldTraits => ({
    size: feed.count(),
    hasSub: spec.sub !== undefined,
    hasJoin: spec.join !== undefined,
    ...(spec.carrier === undefined ? {} : { forced: spec.carrier }),
  })

  let plan = planFold(name, traits())
  let carrier = carrierFor<R, A>(plan.carrier, spec)

  /**
   * Re-plan as the collection grows. The choice was made once, when the fold
   * was built and the collection was often empty; a table that fills up
   * afterwards deserves the carrier it would have been given at its present
   * size. The check itself is a comparison against the thresholds, not a
   * planning run, and a swap costs one rebuild — a full pass — which is why
   * there are two thresholds and not one: up at the limit, down at half of
   * it. A collection breathing around a single line would tear the carrier
   * down and rebuild it on every crossing, paying the structure's price
   * without ever keeping the structure. The gap's own cost is small and not
   * a matter of correctness: a shrunken collection rides the tree a while.
   */
  const replan = (): void => {
    if (spec.carrier !== undefined && spec.carrier !== 'auto') return
    const size = feed.count()
    const grew = plan.carrier !== 'tree' && size >= TREE_WORTH_IT
    const shrank = plan.carrier === 'tree' && size < TREE_WORTH_IT / 2
    if (!grew && !shrank) return
    const next = planFold(name, traits())
    if (next.carrier === plan.carrier) return
    plan = next
    carrier = carrierFor<R, A>(next.carrier, spec)
    carrier.rebuild(rows)
  }

  const ensure = follow(feed, {
    first: () => carrier.rebuild(rows),
    apply(changes) {
      carrier.feed(changes, rows)
      replan()
    },
    resync: () => {
      carrier.rebuild(rows)
      replan()
    },
  })

  return derived(
    () => {
      ensure()
      return carrier.answer()
    },
    { name, equal: spec.equal ?? Object.is },
  )
}
