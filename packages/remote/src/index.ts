// The async package: the shape of an answer from elsewhere, sources with their
// pace and freshness, parametric queries, reconciliation.

export { source, fresh, arrivalOf } from './source.ts'
export type { Source, SourceOptions } from './source.ts'
export { query } from './query.ts'
export type { Query, QueryOptions } from './query.ts'
export {
  EMPTY,
  heldOf,
  ageOf,
  isFresh,
  loading,
  arrived,
  refused,
  together,
  firstOf,
} from './remote.ts'
export type { Remote, Held, Fault } from './remote.ts'
export { reconcile } from './reconcile.ts'
export type { Reconciliation, ReconcileOptions } from './reconcile.ts'
export type { Tally } from './shape.ts'
