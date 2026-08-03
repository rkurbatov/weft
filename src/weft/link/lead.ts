// When there is no shared worker, one tab holds the graph and the others watch
// it over the bus. Which tab is decided by a lock: whoever holds it leads, and
// when that tab dies the lock is free again and somebody else takes over.
//
// The lock is passed in rather than reached for, so this is testable without a
// browser — and so a different way of deciding can be dropped in.

export interface Lock {
  /**
   * Ask for the lock. `onHeld` runs once it is ours, and it stays ours until
   * the returned release is called or this tab goes away.
   */
  hold(name: string, onHeld: () => void): () => void
}

/** The browser's own answer: a lock is released when the tab holding it dies. */
export function webLocks(): Lock {
  const locks = (globalThis as { navigator?: { locks?: LockManagerish } }).navigator?.locks
  if (locks === undefined) throw new Error('weft: no Web Locks here')
  return {
    hold(name, onHeld) {
      const asked = new AbortController()
      let release: (() => void) | undefined
      let given = false
      let dropped = false
      void locks
        .request(name, { signal: asked.signal }, () => {
          // Given after we let go: hand it straight back instead of leading.
          if (dropped || given) return Promise.resolve()
          given = true
          onHeld()
          return new Promise<void>(resolve => {
            release = resolve
          })
        })
        .catch(() => {}) // dropped while still queued; the request rejects
      return () => {
        dropped = true
        // Still queued means there is nothing to release — take the ask back,
        // or the lock is ours the moment it frees up and nobody ever lets go.
        if (release === undefined) asked.abort()
        else release()
      }
    },
  }
}

interface LockManagerish {
  request(
    name: string,
    options: { signal: AbortSignal },
    body: () => Promise<void>,
  ): Promise<unknown>
}

export interface LeadOptions {
  name: string
  lock: Lock
  /** Run the graph and serve whoever comes. Returns the way to stop. */
  lead: () => () => void
  /** Watch whoever is leading. Returns the way to stop. */
  follow: () => () => void
}

/**
 * Follow at once, lead when the lock comes to us. A tab starts as a follower —
 * somebody is probably already leading — and takes over the moment it can.
 */
export function leadOrFollow(options: LeadOptions): () => void {
  let stopFollowing: (() => void) | undefined = options.follow()
  let stopLeading: (() => void) | undefined
  let done = false

  const release = options.lock.hold(options.name, () => {
    if (done) return
    stopFollowing?.()
    stopFollowing = undefined
    stopLeading = options.lead()
  })

  return () => {
    done = true
    stopFollowing?.()
    stopLeading?.()
    release()
  }
}
