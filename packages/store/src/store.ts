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
 * The kinds of value the keep layer promises to return as they went in, over
 * a store that can only hold text.
 *
 * `JSON.stringify` on its own breaks that promise silently: a Date comes back
 * a string, a Map or a Set an empty object, a typed array a dictionary of
 * indices — and the corruption shows up not at the write but at the reload,
 * as a TypeError in whatever read the value back. So each such value travels
 * as a tagged envelope and is unfolded on the way out. A plain object that
 * happens to carry the tag key is wrapped once, so no user value can forge an
 * envelope.
 */
const TAG = '#weft.packed'
/** The tag itself, or the tag under any depth of escaping. */
const FORGED = /^#weft\.packed~*$/
const ESCAPED = /^#weft\.packed~+$/

const VIEWS: Record<string, (numbers: number[]) => ArrayBufferView | ArrayBuffer> = {
  Int8Array: n => Int8Array.from(n),
  Uint8Array: n => Uint8Array.from(n),
  Uint8ClampedArray: n => Uint8ClampedArray.from(n),
  Int16Array: n => Int16Array.from(n),
  Uint16Array: n => Uint16Array.from(n),
  Int32Array: n => Int32Array.from(n),
  Uint32Array: n => Uint32Array.from(n),
  Float32Array: n => Float32Array.from(n),
  Float64Array: n => Float64Array.from(n),
  ArrayBuffer: n => Uint8Array.from(n).buffer,
}

/** Pack a structured-clone-shaped value into JSON text. */
export function pack(value: unknown): string {
  return JSON.stringify(value, function (this: unknown, key: string, folded: unknown) {
    // `toJSON` has already run by the time a replacer is called — a Date
    // arrives here as a string — so the original is taken off the holder.
    const raw = (this as Record<string, unknown>)[key]
    if (raw instanceof Date) return { [TAG]: 'date', at: raw.getTime() }
    if (raw instanceof Map) return { [TAG]: 'map', entries: [...raw.entries()] }
    if (raw instanceof Set) return { [TAG]: 'set', items: [...raw.values()] }
    if (raw instanceof ArrayBuffer) {
      return { [TAG]: 'bulk', kind: 'ArrayBuffer', numbers: [...new Uint8Array(raw)] }
    }
    if (ArrayBuffer.isView(raw) && raw.constructor.name in VIEWS) {
      return {
        [TAG]: 'bulk',
        kind: raw.constructor.name,
        numbers: [...new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)],
      }
    }
    // A user object carrying the tag key must not read as an envelope. It is
    // not boxed — a box would itself carry the tag and send the walk into a
    // loop — the key is escaped instead: one tilde on, one tilde off.
    if (
      typeof raw === 'object' &&
      raw !== null &&
      !Array.isArray(raw) &&
      Object.keys(raw).some(name => FORGED.test(name))
    ) {
      const shifted: Record<string, unknown> = {}
      for (const [name, inner] of Object.entries(raw)) {
        shifted[FORGED.test(name) ? `${name}~` : name] = inner
      }
      return shifted
    }
    return folded
  })
}

/** Unfold what pack folded. */
export function unpack(text: string): unknown {
  return JSON.parse(text, (key: string, value: unknown) => {
    if (typeof value !== 'object' || value === null) return value
    if (!(TAG in value)) {
      // The escape, undone: a key that is the tag under tildes loses one.
      if (!Array.isArray(value) && Object.keys(value).some(name => ESCAPED.test(name))) {
        const shifted: Record<string, unknown> = {}
        for (const [name, inner] of Object.entries(value)) {
          shifted[ESCAPED.test(name) ? name.slice(0, -1) : name] = inner
        }
        return shifted
      }
      return value
    }
    const box = value as Record<string, unknown>
    switch (box[TAG]) {
      case 'date':
        return new Date(box['at'] as number)
      case 'map':
        return new Map(box['entries'] as Array<[unknown, unknown]>)
      case 'set':
        return new Set(box['items'] as unknown[])
      case 'bulk': {
        const bytes = Uint8Array.from(box['numbers'] as number[])
        const make = VIEWS[box['kind'] as string]
        if (make === undefined) return bytes
        if (box['kind'] === 'ArrayBuffer') return bytes.buffer
        const view = make([]) as ArrayBufferView
        const Kind = view.constructor as new (b: ArrayBuffer) => ArrayBufferView
        return new Kind(bytes.buffer)
      }
      default:
        return value
    }
  })
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
        return Promise.resolve(unpack(text))
      } catch {
        backing.removeItem(key)
        return Promise.resolve(undefined)
      }
    },
    write: (key, value) => {
      // A full or blocked store is a refusal, not a shrug: the caller turns it
      // into a visible "not saving", so it must not be swallowed.
      try {
        backing.setItem(key, pack(value))
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
