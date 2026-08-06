// Where kept things live. The interface is asynchronous by design: the graph is
// meant for a worker, and the disk there is IndexedDB, which does not answer in
// the same breath. Values are structured-cloneable data, not text — packing is
// an adapter's business, not the caller's.

export interface Store {
  /** The value under the key, or undefined if there is none. */
  read(key: string): Promise<unknown>
  write(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  /**
   * The keys held, optionally only those under a prefix. Needed to let a
   * household go: without it, a session's leftovers can only be forgotten one
   * known key at a time, and the unknown ones stay forever.
   */
  keys(prefix?: string): Promise<string[]>
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
    keys: prefix =>
      Promise.resolve([...cells.keys()].filter(k => prefix === undefined || k.startsWith(prefix))),
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
    keys: prefix => {
      const found: string[] = []
      for (let i = 0; i < backing.length; i++) {
        const key = backing.key(i)
        if (key !== null && (prefix === undefined || key.startsWith(prefix))) found.push(key)
      }
      return Promise.resolve(found)
    },
  }
}

/**
 * A store scoped to one application and one session. Keys are prefixed, so two
 * people in one browser — a leading tab serving both, or one after the other in
 * the same tab — never read each other's kept things.
 *
 * Two kinds of key live inside a scope. A cache is what can be fetched again;
 * a book is what the person entrusted to us and has not been sent yet. Logging
 * out clears the cache and leaves the book: an unsent note belongs to the one
 * who wrote it and is waiting for them when they come back.
 */
export interface Scope extends Store {
  readonly prefix: string
  /** Keys for things that can be fetched again. Cleared on the way out. */
  cache(key: string): string
  /** Keys for what was entrusted and not yet sent. Kept across a logout. */
  book(key: string): string
  /** The full key as it lands on the disk underneath — for a look, not for use. */
  at(key: string): string
  /** Let the fetchable half go. Books, and everything outside the scope, stay. */
  wipe(): Promise<void>
}

export function within(store: Store, app: string, session: string): Scope {
  for (const part of [app, session])
    if (part.includes('/')) throw new Error(`weft: "${part}" cannot be part of a scope name`)
  const prefix = `${app}/${session}/`
  const at = (key: string): string => `${prefix}${key}`
  return {
    prefix,
    // Keys handed out are relative: the scope prefixes them on the way to the
    // disk, so a caller can never accidentally prefix them twice.
    cache: key => `cache/${key}`,
    book: key => `book/${key}`,
    at,
    read: key => store.read(at(key)),
    write: (key, value) => store.write(at(key), value),
    remove: key => store.remove(at(key)),
    keys: async suffix => {
      const found = await store.keys(prefix + (suffix ?? ''))
      return found.map(key => key.slice(prefix.length))
    },
    wipe: async () => {
      const doomed = await store.keys(`${prefix}cache/`)
      await Promise.all(doomed.map(key => store.remove(key)))
    },
  }
}
