// A graph on one side, a screen on the other.
//
// A station declares a surface and hands out mirrors of it; tables travel as
// differences, a call that never came back is unknown rather than refused, and
// the work can be handed to another tab mid-flight. What it all travels on —
// a worker pair, a broadcast line between tabs — is chosen here too, at the
// level of "which kind", not "how it is wired".

export { handOver, handedOver, link, listed, serve, Unknown } from '#link'
export type {
  HandedOver,
  Link,
  LinkOptions,
  ListOffer,
  Mirrored,
  ServeOptions,
  Surface,
} from '#link'

export { atOnce, every, hurried, overWire, perFrame, wirePair } from '#wire'
export type { Channel, Hurried, Schedule, Wire, WirePair } from '#wire'
