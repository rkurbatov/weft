// Where the table lives is one decision, made here.
//
// The panel below follows the whole table over a wire that can be told to drop
// batches — because the interesting part of the protocol is what happens when
// one goes missing.

import { adopt, cell } from '#loom'
import { overWire } from '#weft'
import type { Adopted, Mirrored, Port } from '#loom'
import { mount } from '#demo/mount.tsx'
import { App } from './App.tsx'
import type { Job } from './state.ts'
import './desk.css'

export interface Desk {
  readonly size: { get(): number | undefined }
  readonly poured: { get(): number | undefined }
  readonly edited: { get(): number | undefined }
  readonly recomputed: { get(): number | undefined }
  readonly woken: { get(): number | undefined }
  readonly jobs: Mirrored<Job>
  readonly pour: (count: number) => Promise<void>
  readonly touch: (count: number) => Promise<void>
  /** Whether the wire is dropping batches on purpose. */
  readonly losing: Port<boolean>
}

function start(): Desk {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  const losing = cell(false, { name: 'losing' })

  // A wire with a switch: when it is on, batches of changes are dropped before
  // they reach this side. Snapshots are let through, or there would be nothing
  // to lose in the first place.
  const wire = overWire(worker)
  const lossy = {
    send: (message: unknown) => wire.send(message),
    listen: (handler: (message: unknown) => void) =>
      wire.listen(message => {
        const kind = (message as { kind?: string }).kind
        if (losing.peek() && kind === 'changed') return
        handler(message)
      }),
  }

  const station: Adopted = adopt(lossy)
  return {
    size: station.view<number>('size'),
    poured: station.view<number>('poured'),
    edited: station.view<number>('edited'),
    recomputed: station.view<number>('recomputed'),
    woken: station.view<number>('woken'),
    jobs: station.table<Job>('jobs'),
    pour: station.act<[number]>('pour'),
    touch: station.act<[number]>('touch'),
    losing,
  }
}

// Module state, not effect state: the world outlives a tab's renders.
export const desk = cell(start(), { name: 'desk' })

mount(<App />)
