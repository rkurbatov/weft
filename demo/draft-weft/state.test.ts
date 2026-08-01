import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryStore } from '#core/store.ts'
import { draftState } from './state.ts'

function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

test('the draft survives a reload', async () => {
  const store = memoryStore()

  const first = draftState(store)
  first.draft.set('typed and left')
  await settle()
  first.kept.stop()

  const second = draftState(store)
  assert.equal(await second.kept.restored, true)
  assert.equal(second.draft.peek(), 'typed and left')
  second.kept.stop()
})

test('the draft survives through the real IndexedDB path, two page loads long', async () => {
  const { IDBFactory } = await import('fake-indexeddb')
  const had = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
  Object.defineProperty(globalThis, 'indexedDB', {
    value: new IDBFactory(),
    configurable: true,
  })
  try {
    const { idbStore } = await import('#core/idb.ts')

    // The first page load, exactly as App.tsx arranges it.
    const first = draftState(idbStore('weft-demo-draft'))
    first.draft.set('typed, then F5')
    await settle()
    await settle() // the write pump lands on the database

    // The page dies without a goodbye; a fresh load opens the same database.
    const second = draftState(idbStore('weft-demo-draft'))
    assert.equal(await second.kept.restored, true)
    assert.equal(second.draft.peek(), 'typed, then F5')
    first.kept.stop()
    second.kept.stop()
  } finally {
    if (had === undefined) delete (globalThis as { indexedDB?: unknown }).indexedDB
    else Object.defineProperty(globalThis, 'indexedDB', had)
  }
})
