// A disk a test drives by hand: it answers only when told to, and refuses when
// told to refuse. One gate is enough for both — a refusal is an answer that
// happens to be a rejection — and a second, switch-driven disk turned out to
// duplicate it without ever being used.

import assert from 'node:assert/strict'
import { cleanupWith } from './lifetime.ts'
import { settle } from './world.ts'
import type { Store } from '#store'

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
