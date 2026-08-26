// Whose screen this is: an application and a session inside it.
//
// A durable book cannot be anonymous — two people signing in one after another
// in the same browser would otherwise share one, and the second would send the
// first's unsent work. That was said at every `will()`, which meant the
// application repeated at every intent something it knows exactly once: at
// assembly, where it names itself and knows who is signed in.
//
// So it is said there, and stands while the station is built. Ambient rather
// than threaded through: everything a station makes is made inside that one
// call, and the alternative is an `owner` argument on every constructor in the
// dialect, most of which have nothing to do with storage.
//
// Deliberately not a default: no session named, no ambient owner, and a
// durable book still refuses to open itself. Ownership can be inherited but
// never assumed.

export interface Owner {
  readonly app: string
  readonly session: string
}

let standing: Owner | undefined

/**
 * Build under this owner. Restores whatever stood before, so nesting is safe.
 *
 * Synchronous, and it says so in the type: the owner is put down the moment
 * the body returns, so a body that returns a promise would be running its real
 * work — the part that makes the book — after it had already been put down.
 * Refusing the shape outright is the only honest answer; a station is built
 * synchronously, and one that has to wait for something builds itself and
 * fills itself in afterwards.
 */
export function underOwner<T>(
  owner: Owner,
  body: () => T extends PromiseLike<unknown> ? never : T,
): T {
  const before = standing
  standing = owner
  try {
    const made = body()
    if (typeof (made as PromiseLike<unknown>)?.then === 'function') {
      throw new TypeError(
        'loom: underOwner is synchronous — its body may not return a promise, since the owner is put down before an awaited line would run',
      )
    }
    return made as T
  } finally {
    standing = before
  }
}

/** Whose the thing being built is, if anybody said. */
export function ownerNow(): Owner | undefined {
  return standing
}
