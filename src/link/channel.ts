// The wire between a graph and whoever is watching it. Two functions — send and
// listen — and a handful of messages. In one process the two ends are a pair of
// functions; in a browser they are a worker; nothing above this layer can tell.

export interface Channel {
  send(message: unknown): void
  /** Returns the way to stop listening. */
  listen(handler: (message: unknown) => void): () => void
}

export type ToGraph =
  | { readonly kind: 'watch'; readonly id: number; readonly cell: string; readonly key?: unknown }
  | { readonly kind: 'unwatch'; readonly id: number }
  | {
      readonly kind: 'call'
      readonly id: number
      readonly command: string
      readonly args: readonly unknown[]
    }

export type ToWatcher =
  /** The graph's side is up. Anyone watching should ask again — it knows nothing of what came before. */
  | { readonly kind: 'up' }
  | { readonly kind: 'values'; readonly changed: ReadonlyArray<{ id: number; value: unknown }> }
  | { readonly kind: 'done'; readonly id: number; readonly value: unknown }
  | { readonly kind: 'failed'; readonly id: number; readonly error: string }

/** What to do with work that must not happen more than once a frame. */
export type Schedule = (work: () => void) => void

/**
 * Once a frame in the foreground — and still soon in the background, where the
 * browser freezes frames entirely: a leading tab must keep serving the others
 * after the person switches away, so a timer races the frame and whichever
 * comes first does the work, once.
 */
export const perFrame: Schedule = work => {
  const frame = (globalThis as { requestAnimationFrame?: (fn: () => void) => unknown })
    .requestAnimationFrame
  if (frame === undefined) {
    setTimeout(work, 0)
    return
  }
  let done = false
  const once = (): void => {
    if (done) return
    done = true
    work()
  }
  frame(once)
  setTimeout(once, 60)
}

/** Everything at once, for tests that want no waiting. */
export const atOnce: Schedule = work => work()
