// Where kept things live. The interface is asynchronous by design: the graph is
// meant for a worker, and the disk there is IndexedDB, which does not answer in
// the same breath. Values are structured-cloneable data, not text — packing is
// an adapter's business, not the caller's.

export interface Store {
  /** The value under the key, or undefined if there is none. */
  read(key: string): Promise<unknown>
  write(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

/**
 * Whatever was written last, in memory. For tests and for a fallback. Values
 * are cloned on the way in and out, exactly as a real disk would part with
 * them, so a value that could not survive keeping fails here too.
 */
export function memoryStore(seed: Record<string, unknown> = {}): Store {
  const cells = new Map<string, unknown>(Object.entries(seed))
  return {
    read: key => Promise.resolve(cells.has(key) ? structuredClone(cells.get(key)) : undefined),
    write: (key, value) => {
      cells.set(key, structuredClone(value))
      return Promise.resolve()
    },
    remove: key => {
      cells.delete(key)
      return Promise.resolve()
    },
  }
}

/**
 * Browser storage for the case without a worker; otherwise an in-memory
 * stand-in. Text packing is this adapter's own detail; rubbish it cannot read
 * is its own to clear.
 */
export function webStore(area: 'local' | 'session' = 'local'): Store {
  const backing =
    typeof globalThis === 'object' && 'localStorage' in globalThis
      ? ((area === 'local' ? globalThis.localStorage : globalThis.sessionStorage) as Storage)
      : undefined
  if (backing === undefined) return memoryStore()
  return {
    read: key => {
      const text = backing.getItem(key)
      if (text === null) return Promise.resolve(undefined)
      try {
        return Promise.resolve(JSON.parse(text) as unknown)
      } catch {
        backing.removeItem(key)
        return Promise.resolve(undefined)
      }
    },
    write: (key, value) => {
      // A full or blocked store is a refusal, not a shrug: the caller turns it
      // into a visible "not saving", so it must not be swallowed.
      try {
        backing.setItem(key, JSON.stringify(value))
        return Promise.resolve()
      } catch (error) {
        return Promise.reject(error as Error)
      }
    },
    remove: key => {
      backing.removeItem(key)
      return Promise.resolve()
    },
  }
}
