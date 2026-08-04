// Buses that close themselves.
//
// A `BroadcastChannel` nobody closes keeps the process alive, and a run that
// will not end looks exactly like a run that hangs. Every bus opened here is
// unreferenced and closed when the test ends.

import { BroadcastChannel } from 'node:worker_threads'
import { cleanupWith } from './lifetime.ts'

interface Busish {
  postMessage(message: unknown): void
  addEventListener(kind: 'message', handler: (event: { data: unknown }) => void): void
  removeEventListener(kind: 'message', handler: (event: { data: unknown }) => void): void
  close(): void
}

/** A bus on the given name, closed when the test ends. */
export function onBus(name: string): Busish {
  const line = new BroadcastChannel(name)
  line.unref?.()
  cleanupWith(() => line.close())
  return line as unknown as Busish
}
