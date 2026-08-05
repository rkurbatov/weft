// Disks a test can misbehave with: one that answers only when told to, and one
// with a switch for refusing writes. Both used to be written out inside the
// files that needed them.

import assert from 'node:assert/strict'
import { cleanupWith } from './lifetime.ts'
import { settle } from './world.ts'
import type { Store } from '#offline/store.ts'

export interface SlowStore {
  readonly store: Store
  readonly cells: Map<string, unknown>
  /** What has been asked of the disk and not yet answered, in order. */
  asked(): string[]
  /** Answer the next question — or refuse it, if given an error. */
  release(error?: Error): Promise<void>
  /** Answer all outstanding questions. */
  releaseAll(): Promise<void>
}

/** A disk that answers only when told to. Every operation queues a gate. */
export function slowStore(seed: Record<string, unknown> = {}): SlowStore {
  const cells = new Map<string, unknown>(Object.entries(seed))
  const gates: Array<{ kind: string; open: () => void; slam: (error: Error) => void }> = []
  const wait = <T>(kind: string, work: () => T): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      gates.push({ kind, open: () => resolve(work()), slam: reject })
    })
  // A gate nobody opens holds a promise forever; dropping them at the end of
  // the test keeps that from looking like a hang.
  cleanupWith(() => {
    gates.length = 0
  })
  return {
    cells,
    store: {
      read: key =>
        wait('read', () => (cells.has(key) ? structuredClone(cells.get(key)) : undefined)),
      write: (key, value) =>
        wait('write', () => {
          cells.set(key, structuredClone(value))
        }),
      remove: key =>
        wait('remove', () => {
          cells.delete(key)
        }),
      keys: prefix =>
        wait('keys', () =>
          [...cells.keys()].filter(key => prefix === undefined || key.startsWith(prefix)),
        ),
    },
    asked: () => gates.map(gate => gate.kind),
    async release(error?: Error) {
      const gate = gates.shift()
      assert.notEqual(gate, undefined, 'nothing waiting on the disk')
      if (error === undefined) gate?.open()
      else gate?.slam(error)
      await settle()
    },
    async releaseAll() {
      while (gates.length > 0) {
        gates.shift()?.open()
        await settle()
      }
    },
  }
}

export interface BreakableStore {
  readonly store: Store
  /** Writes start refusing. Reads keep working: a full disk still reads. */
  break(): void
  mend(): void
}

/** A disk with a switch, for showing what a refusal to save looks like. */
export function breakableStore(seed: Record<string, unknown> = {}): BreakableStore {
  const cells = new Map<string, unknown>(Object.entries(seed))
  let broken = false
  return {
    store: {
      read: key => Promise.resolve(cells.has(key) ? structuredClone(cells.get(key)) : undefined),
      write: (key, value) => {
        if (broken) return Promise.reject(new Error('disk is broken'))
        cells.set(key, structuredClone(value))
        return Promise.resolve()
      },
      remove: key => {
        if (broken) return Promise.reject(new Error('disk is broken'))
        cells.delete(key)
        return Promise.resolve()
      },
      keys: prefix =>
        Promise.resolve(
          [...cells.keys()].filter(key => prefix === undefined || key.startsWith(prefix)),
        ),
    },
    break: () => {
      broken = true
    },
    mend: () => {
      broken = false
    },
  }
}
