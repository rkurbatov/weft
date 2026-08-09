// What a place to keep things promises, and what keeping means — said once.
//
// Three files implement halves of it: `store.ts` holds the places themselves,
// `idb.ts` one of them, `keep.ts` what a cell does with any of them. A promise
// read from inside one implementation is a promise nobody reads.

import type { Watchable } from '#graph'

/** Why something on disk was not put back. */
export type Dropped = 'version' | 'age' | 'unreadable'

/** Whether what happens here is reaching the store. */
export type Saving = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export interface KeepOptions<T> {
  key: string
  store: Store
  /** Bump it when the shape changes; anything written under another version is dropped or migrated. */
  version?: number
  /** Anything older than this is not put back. */
  maxAge?: number
  now?: () => number
  /** Rescue what an older version wrote. Return undefined to drop it. */
  migrate?: (stored: unknown, from: number) => T | undefined
  onDropped?: (why: Dropped, key: string) => void
}

export interface Kept {
  /** Resolves once the disk has been asked: true if something was put back. */
  readonly restored: Promise<boolean>
  /** Are writes landing. `ok: false` names the reason they are not. */
  readonly saving: Watchable<Saving>
  /** Stop keeping it; what is on disk stays. */
  stop(): void
  /** Stop keeping it and wipe what is on disk. */
  forget(): void
}

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
