// oxlint-disable unicorn/prefer-add-event-listener -- IndexedDB requests are
// one-shot: a single handler each, and our minimal typings (Requestish,
// Databaseish) declare only the on* properties the store actually uses.

// A Store on IndexedDB — the disk a worker actually has. Values go in as they
// are: the database clones structurally, so a Date survives and numbers stay
// numbers, with no text packing on the way.
//
// The connection is opened lazily and held. Another tab upgrading the schema
// (versionchange) or the browser taking the connection away (close) drops it;
// the next operation opens afresh. Transactions default to relaxed durability —
// a kept value is a cache, not a ledger — and are committed explicitly rather
// than left to the auto-commit.

import { memoryStore } from './store.ts'
import type { Store } from './store.ts'

export interface IdbOptions {
  /** The object store inside the database. One database may hold several. */
  store?: string
  /** 'relaxed' does not wait for the platform to flush — right for a cache;
   *  'strict' is for a book that must survive power loss. */
  durability?: 'strict' | 'relaxed'
}

export function idbStore(name: string, options: IdbOptions = {}): Store {
  const factory = (globalThis as { indexedDB?: Factoryish }).indexedDB
  if (factory === undefined) throw new Error('weft: no IndexedDB here')
  const storeName = options.store ?? 'kv'
  const durability = options.durability ?? 'relaxed'

  let opening: Promise<Databaseish> | undefined

  const openAt = (version?: number): Promise<Databaseish> =>
    new Promise((resolve, reject) => {
      const request = factory.open(name, version)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName)
      }
      request.onsuccess = () => {
        const db = request.result
        // Somebody else is upgrading: holding on would block them forever.
        db.onversionchange = () => {
          db.close()
          opening = undefined
        }
        db.onclose = () => {
          opening = undefined
        }
        resolve(db)
      }
      request.onerror = () => reject(asError(request.error))
    })

  // Open at whatever version the database is — pinning one would break the
  // moment anybody else bumps it. Only a missing object store forces a bump.
  const open = (): Promise<Databaseish> => {
    opening ??= (async () => {
      let db = await openAt()
      if (!db.objectStoreNames.contains(storeName)) {
        const version = db.version + 1
        db.close()
        db = await openAt(version)
      }
      return db
    })().catch((error: unknown) => {
      opening = undefined
      throw error
    })
    return opening
  }

  const run = async <T>(
    mode: 'readonly' | 'readwrite',
    act: (store: ObjectStoreish) => Requestish<T>,
  ): Promise<T> => {
    let db = await open()
    let tx: Transactionish
    try {
      tx = db.transaction(storeName, mode, { durability })
    } catch {
      // The connection died between operations (an upgrade elsewhere, a browser
      // reclaim). Open once more; a second failure is a real answer.
      opening = undefined
      db = await open()
      tx = db.transaction(storeName, mode, { durability })
    }
    return await new Promise<T>((resolve, reject) => {
      const request = act(tx.objectStore(storeName))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(asError(request.error))
      // The requests are all placed; there is nothing to wait for.
      tx.commit?.()
    })
  }

  return {
    read: key => run('readonly', store => store.get(key)),
    write: (key, value) => run<unknown>('readwrite', store => store.put(value, key)).then(() => {}),
    remove: key => run<unknown>('readwrite', store => store.delete(key)).then(() => {}),
  }
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}

// Just enough of the IndexedDB shapes used above. The real ones live in the DOM
// type definitions, which this package deliberately does not pull in.

interface Factoryish {
  open(name: string, version?: number): OpenRequestish
}

interface Requestish<T> {
  readonly result: T
  readonly error: unknown
  onsuccess: (() => void) | null
  onerror: (() => void) | null
}

interface OpenRequestish extends Requestish<Databaseish> {
  onupgradeneeded: (() => void) | null
}

interface Databaseish {
  readonly version: number
  readonly objectStoreNames: { contains(name: string): boolean }
  createObjectStore(name: string): unknown
  transaction(
    name: string,
    mode: 'readonly' | 'readwrite',
    options?: { durability: 'strict' | 'relaxed' },
  ): Transactionish
  close(): void
  onversionchange: (() => void) | null
  onclose: (() => void) | null
}

interface Transactionish {
  objectStore(name: string): ObjectStoreish
  commit?: () => void
}

interface ObjectStoreish {
  get(key: string): Requestish<unknown>
  put(value: unknown, key: string): Requestish<unknown>
  delete(key: string): Requestish<unknown>
}

/**
 * The best shelf this platform has for something that must outlive the tab: the
 * browser's database where there is one, memory where there is not. Durability
 * is 'strict' — a book of unsent intents is not a cache.
 *
 * Which one was taken is not a secret: `where` says it plainly, so an assembly
 * can refuse or warn instead of silently keeping a book that dies with the tab.
 */
export function bestStore(
  name: string,
  options: IdbOptions = {},
): Store & { where: 'disk' | 'memory' } {
  if (typeof indexedDB === 'undefined') {
    return Object.assign(memoryStore(), { where: 'memory' as const })
  }
  const disk = idbStore(name, { durability: 'strict', ...options })
  return Object.assign(disk, { where: 'disk' as const })
}
