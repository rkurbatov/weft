// The test kit: one door, so a test file starts with one import line.
//
// A package like any other, because the tests of every package reach for it —
// and a set of helpers reached by four dots of relative path is the first
// thing that breaks when anything moves.

// `cleanupWith` is not offered: held/until/closing cover every case a test has
// had so far, and a raw registration invites cleanup written by hand again.
export { closing, held, until } from './lifetime.ts'
export { settle, wait, world } from './world.ts'
export type { World } from './world.ts'
// Two more checks lived here — by one field, and by count — and in two
// campaigns no test wanted them: what tests actually compare is either a list
// of ids or a whole value. Brought back the day something needs them.
export { hasIds, holds, track, wakings } from './check.ts'
export { setupWire } from './wire.ts'
export { slowStore } from './store.ts'
export { onBus } from './bus.ts'
