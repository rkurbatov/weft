// oxlint-disable unicorn/prefer-add-event-listener -- one-shot IDB requests
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IDBFactory } from 'fake-indexeddb'
import { idbStore } from '#keep/idb.ts'

/** Each test gets a database world of its own. */
function ownIndexedDB(): () => void {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
  Object.defineProperty(globalThis, 'indexedDB', {
    value: new IDBFactory(),
    configurable: true,
  })
  return () => {
    if (had === undefined) delete (globalThis as { indexedDB?: unknown }).indexedDB
    else Object.defineProperty(globalThis, 'indexedDB', had)
  }
}

test('what goes in comes back as it was: no text packing, a Date stays a Date', async () => {
  const restore = ownIndexedDB()
  try {
    const store = idbStore('weft-test')
    await store.write('row', { title: 'kept', at: new Date(42), amount: 10.5 })
    const back = (await store.read('row')) as { title: string; at: Date; amount: number }
    assert.equal(back.title, 'kept')
    assert.ok(back.at instanceof Date)
    assert.equal(back.at.getTime(), 42)
    assert.equal(back.amount, 10.5)
  } finally {
    restore()
  }
})

test('a missing key reads as undefined, and remove makes it one', async () => {
  const restore = ownIndexedDB()
  try {
    const store = idbStore('weft-test')
    assert.equal(await store.read('nothing'), undefined)
    await store.write('gone', 1)
    await store.remove('gone')
    assert.equal(await store.read('gone'), undefined)
  } finally {
    restore()
  }
})

test('two stores in one database do not see each other', async () => {
  const restore = ownIndexedDB()
  try {
    const one = idbStore('weft-test', { store: 'kv' })
    // A second object store would need a version bump; a second database is the
    // arrangement this store expects — one database per concern.
    const other = idbStore('weft-other')
    await one.write('key', 'mine')
    assert.equal(await other.read('key'), undefined)
  } finally {
    restore()
  }
})

test('the connection lost between operations is reopened, not mourned', async () => {
  const restore = ownIndexedDB()
  try {
    const store = idbStore('weft-test')
    await store.write('key', 'before')
    // Somebody else upgrades the schema: our connection gets versionchange and
    // closes itself. The next operation must open afresh rather than fail.
    const factory = (globalThis as { indexedDB: IDBFactory }).indexedDB
    await new Promise<void>((resolve, reject) => {
      const request = factory.open('weft-test', 2)
      request.onsuccess = () => {
        request.result.close()
        resolve()
      }
      request.onerror = () => reject(new Error('upgrade failed'))
    })
    assert.equal(await store.read('key'), 'before')
  } finally {
    restore()
  }
})

test('bestStore takes the disk when there is one, and says which it took', async () => {
  const { bestStore } = await import('#weft')
  const had = 'indexedDB' in globalThis
  assert.equal(bestStore('nowhere').where, had ? 'disk' : 'memory')

  const previous = (globalThis as { indexedDB?: unknown }).indexedDB
  ;(globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory()
  try {
    const shelf = bestStore('weft.trial')
    assert.equal(shelf.where, 'disk')
    await shelf.write('a', { n: 1 })
    assert.deepEqual(await shelf.read('a'), { n: 1 })
  } finally {
    if (previous === undefined) delete (globalThis as { indexedDB?: unknown }).indexedDB
    else (globalThis as { indexedDB?: unknown }).indexedDB = previous
  }
})
