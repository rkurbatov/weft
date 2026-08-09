// What a message travels on, and who it travels to.
//
// Channels and the pace they run at, the two ends of a pair, broadcast lines
// between tabs, envelopes with names on them, shared workers, and the lock by
// which one tab becomes the one doing the work. None of it knows what is being
// carried: the protocol between a graph and a watcher lives one layer up, and
// is carried rather than read.

export { wirePair, overWire } from './wires.ts'
export type { WirePair, Wire } from './wires.ts'
export { atOnce, every, hurried, perFrame } from './channel.ts'
export type { Channel, Hurried, Schedule, ToGraph, ToWatcher } from './channel.ts'
export { localBroadcast, openBroadcast, overBus } from './transport.ts'
export type { Broadcast, BusLike } from './transport.ts'
export { busHub, busChannel } from './bus.ts'
export type { Hub, HubOptions, KeepAliveOptions } from './bus.ts'
export { sharedWorkerHub, sharedWorkerChannel, sharedWorkersExist } from './shared.ts'
export type { SharedScope } from './shared.ts'
export { leadOrFollow, webLocks } from './lead.ts'
export type { Lock, LeadOptions } from './lead.ts'
