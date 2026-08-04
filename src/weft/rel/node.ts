// The relational tree: a derived collection as data, not as a closure.
//
// A node is a plain value — primitive, attributes, inputs — following the
// thirteen-primitive table of the language corpus (Warp 10-IR); this file
// carries the ones implemented so far and grows one primitive at a time.
// Expressions inside attributes are data too (expr.ts), so a whole tree
// serialises, hashes and runs against another implementation. A closure may
// stand in for any expression as an escape hatch, and the tree then honestly
// loses its canon: no hash, no place in the cross-implementation corpus.
//
// Keys are declared, not guessed: a source names the fields its key is made
// of, and every derivation's key follows by rule — filter and pure inherit.
// That is what lets a derived row be found, moved and explained by key, and
// a `pure` that picks away a key field is a build error, not a surprise.
//
// The naive recount here is the oracle: the slowest correct answer, the
// floor every faster path is measured against — and the resync path when a
// follower falls too far behind.

export * from './shape.ts'
export * from './keys.ts'
export * from './canon.ts'
export * from './check.ts'
export * from './work.ts'
export * from './recount.ts'
export * from './params.ts'
export * from './why.ts'
