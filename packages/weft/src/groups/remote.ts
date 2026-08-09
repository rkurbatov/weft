// Answers from elsewhere: what shape they arrive in, and what keeps them fresh.
//
// A supply is a delivery that keeps asking while somebody watches; a query is
// one supply per key; reconciling holds the world to a stated goal instead of
// firing events at it.

export {
  ageOf,
  arrivalOf,
  firstOf,
  fresh,
  heldOf,
  isFresh,
  query,
  reconcile,
  supply,
  together,
} from '#remote'
export type {
  Fault,
  Held,
  Query,
  QueryOptions,
  ReconcileOptions,
  Reconciliation,
  Remote,
  Supply,
  SupplyPassport,
  Tally,
} from '#remote'
