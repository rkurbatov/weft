// A made-up log to search through, the same one every time.
//
// The page needs a body of text big enough that searching it is real work —
// something a browser would stutter on if it did it on the main thread. A
// seeded generator rather than random lines, so that two runs and two tabs
// search the same thing and a number on the page means something.

function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_00_00_00_00
  }
}

const WHO = ['api', 'worker', 'db', 'cache', 'auth', 'mailer', 'billing', 'search']
const WHAT = [
  'request finished',
  'request failed',
  'connection lost',
  'connection restored',
  'retry scheduled',
  'cache miss',
  'cache hit',
  'slow query',
  'token refreshed',
  'payment declined',
  'payment accepted',
  'queue drained',
]

export interface Line {
  readonly id: number
  readonly text: string
}

/** `count` lines of a made-up service log, decided entirely by the seed. */
export function logLines(count: number, seed = 1): Line[] {
  const next = seeded(seed)
  const out: Line[] = []
  for (let id = 0; id < count; id++) {
    const who = WHO[Math.floor(next() * WHO.length)] ?? 'api'
    const what = WHAT[Math.floor(next() * WHAT.length)] ?? 'request finished'
    const ms = Math.floor(next() * 2000)
    out.push({ id, text: `[${who}] ${what} in ${String(ms)}ms` })
  }
  return out
}

/**
 * The search: every line that contains the needle, and how long it took.
 *
 * Deliberately the plain, slow way — this stands in for a real engine, and
 * what the page is about is where the work runs, not how clever it is.
 */
export function search(
  lines: readonly Line[],
  needle: string,
  limit = 50,
): { found: Line[]; total: number; ms: number } {
  const started = performance.now()
  const found: Line[] = []
  let total = 0
  if (needle !== '') {
    for (const line of lines) {
      if (!line.text.includes(needle)) continue
      total++
      if (found.length < limit) found.push(line)
    }
  }
  return { found, total, ms: performance.now() - started }
}
