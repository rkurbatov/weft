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

export interface Progress {
  /** The first `limit` matching lines — what a screen can show. */
  readonly found: Line[]
  /** How many matched so far. */
  readonly total: number
  /** How many lines have been looked at. */
  readonly seen: number
  /** Whether the run reached the end of the log. */
  readonly done: boolean
  readonly ms: number
}

/**
 * The search, in chunks.
 *
 * Deliberately the plain, slow way — this stands in for a real engine, and
 * what the page is about is when the work runs, not how clever it is.
 *
 * Yields after every chunk so the caller can publish what it has and check
 * whether anybody still wants it. `partOf` is what makes a partial answer a
 * real answer: a count over a fifth of the log is a count, and the panel is
 * told which fifth.
 */
export function* searching(
  lines: readonly Line[],
  needle: string,
  chunk = 20_000,
  limit = 50,
): Generator<Progress, Progress, undefined> {
  const started = performance.now()
  const found: Line[] = []
  let total = 0
  let seen = 0

  if (needle === '') {
    return { found, total, seen: lines.length, done: true, ms: 0 }
  }

  while (seen < lines.length) {
    const end = Math.min(lines.length, seen + chunk)
    for (let i = seen; i < end; i++) {
      const line = lines[i]
      if (line === undefined || !line.text.includes(needle)) continue
      total++
      if (found.length < limit) found.push(line)
    }
    seen = end
    const step: Progress = {
      found: [...found],
      total,
      seen,
      done: seen >= lines.length,
      ms: performance.now() - started,
    }
    if (step.done) return step
    yield step
  }
  return { found, total, seen, done: true, ms: performance.now() - started }
}

/** The whole search at once, for callers that do not care to see it grow. */
export function search(
  lines: readonly Line[],
  needle: string,
  limit = 50,
): { found: Line[]; total: number; ms: number } {
  const run = searching(lines, needle, lines.length, limit)
  let step = run.next()
  while (step.done === false) step = run.next()
  return { found: step.value.found, total: step.value.total, ms: step.value.ms }
}
