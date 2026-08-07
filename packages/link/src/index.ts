// The ipc package: transport, addressing, the tab protocol, serving a graph to
// other tabs and mirroring one from them, leadership.

export { serve } from './serve.ts'
export type { Surface, ServeOptions } from './serve.ts'
export { link, Unknown } from './link.ts'
export type { Link, LinkOptions, Mirrored } from './link.ts'
export { wirePair, overWire } from './wires.ts'
export type { WirePair, Wire } from './wires.ts'
export { busHub, busChannel } from './bus.ts'
export type { Hub, HubOptions, KeepAliveOptions } from './bus.ts'
export { localBroadcast, openBroadcast, overBus } from './transport.ts'
export type { Broadcast, BusLike } from './transport.ts'
export { sharedWorkerHub, sharedWorkerChannel, sharedWorkersExist } from './shared.ts'
export type { SharedScope } from './shared.ts'
export { leadOrFollow, webLocks } from './lead.ts'
export type { Lock, LeadOptions } from './lead.ts'
export { atOnce, every, hurried, perFrame } from './channel.ts'
export type { Channel, Hurried, Schedule, ToGraph, ToWatcher } from './channel.ts'
