// What the library noticed: one channel for all of it.
//
// Decisions it made by itself — which carrier a fold got, where a scan keeps
// its carry — and things it thinks are worth a word: a collection too large to
// keep piece by piece, a join with a crowd under one key. These used to be
// four separate channels with four shapes, each with no listener but the
// tests, which is how a library ends up talking to nobody.
//
// A notice carries its own sentence, so whoever shows it needs to know nothing
// about what produced it, and its own detail, so a panel that does know can
// show more. Nobody listening and it is a warning — it goes to the console,
// once per kind and place, because a decision nobody hears is no decision.
//
// This lives at the bottom, below everything that reports into it.

export type Level = 'note' | 'warn'

export interface Notice {
  /** What kind of thing this is: 'fold-plan', 'wholesale', 'crowded-join'… */
  readonly kind: string
  /** Which node, table, join or cell it is about. */
  readonly where: string
  /** A note is the library working as intended; a warning wants a human. */
  readonly level: Level
  /** One sentence, ready to show. */
  readonly message: string
  /** Everything a panel might want to show beyond the sentence. */
  readonly detail?: Readonly<Record<string, unknown>>
}

const listeners = new Set<(what: Notice) => void>()
const said = new Set<string>()

/** Hear everything the library notices. Returns the way to stop hearing it. */
export function onNotice(listener: (what: Notice) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function notice(what: Notice): void {
  if (listeners.size > 0) {
    for (const listener of listeners) listener(what)
    return
  }
  if (what.level !== 'warn') return
  // Once per kind and place: a screen redrawing sixty times a second must not
  // be told sixty times a second.
  const once = `${what.kind}:${what.where}`
  if (said.has(once)) return
  said.add(once)
  console.warn(`weft: ${what.message}`)
}

/** For tests: forget what has already been said. */
export function forgetNotices(): void {
  said.clear()
}
