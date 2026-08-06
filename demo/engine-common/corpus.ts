// A made-up service log, held the way such data is actually held.
//
// Two million lines as JavaScript strings cost about six hundred megabytes:
// every line is an object with a header, two bytes per character and a pointer
// in an array, and the useful part of that is maybe sixty bytes. The same lines
// as one UTF-8 buffer with an index of offsets cost fifteen — and searching
// them is three times faster, because the bytes lie together instead of being
// scattered across the heap.
//
// So that is what this is: one buffer, one Uint32Array of line starts, and no
// strings at all until a line has to be shown. Fifty lines end up on screen;
// the other one million nine hundred and ninety nine thousand nine hundred and
// fifty are never turned into strings.
//
// The generator is seeded, so two runs and two tabs search exactly the same
// corpus and a number on the page means something.

function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_00_00_00_00
  }
}

const WHO = [
  'api',
  'worker',
  'db',
  'cache',
  'auth',
  'mailer',
  'billing',
  'search',
  'gateway',
  'scheduler',
  'indexer',
  'uploads',
  'reports',
  'sessions',
  'webhooks',
  'importer',
]

const LEVEL = ['debug', 'info', 'warn', 'error']

const WHAT = [
  'request finished',
  'request failed',
  'connection lost',
  'connection restored',
  'retry scheduled',
  'retry exhausted',
  'cache miss',
  'cache hit',
  'cache evicted',
  'slow query',
  'query planned',
  'index rebuilt',
  'token refreshed',
  'token rejected',
  'payment declined',
  'payment accepted',
  'refund issued',
  'queue drained',
  'queue backed up',
  'lease renewed',
  'lease lost',
  'snapshot written',
  'snapshot restored',
  'migration applied',
  'quota exceeded',
  'rate limited',
  'session expired',
  'session resumed',
  'upload rejected',
  'upload finished',
  'report generated',
  'webhook delivered',
  'webhook dropped',
  'shard rebalanced',
  'replica lagging',
  'replica caught up',
]

const REGION = ['eu-west', 'eu-north', 'us-east', 'us-west', 'ap-south', 'sa-east']

export interface Line {
  readonly id: number
  readonly text: string
}

/** The corpus: bytes, an index of where each line starts, and how many. */
export interface Log {
  readonly bytes: Uint8Array
  /** `length + 1` offsets: line `i` is `bytes[offsets[i] .. offsets[i + 1]]`. */
  readonly offsets: Uint32Array
  readonly length: number
  /** How much memory the corpus actually occupies. */
  readonly size: number
  /** One line as text — for the fifty that get shown. */
  at(id: number): string
}

const decoder = new TextDecoder()

/** Build `count` lines of made-up log into one buffer. */
export function logLines(count: number, seed = 1): Log {
  const next = seeded(seed)
  const encoder = new TextEncoder()
  // Sixty-four bytes a line is generous for this shape; the buffer is trimmed
  // to what was actually written.
  const bytes = new Uint8Array(count * 72)
  const offsets = new Uint32Array(count + 1)
  let at = 0

  for (let id = 0; id < count; id++) {
    const level = LEVEL[Math.floor(next() * LEVEL.length)] ?? 'info'
    const who = WHO[Math.floor(next() * WHO.length)] ?? 'api'
    const region = REGION[Math.floor(next() * REGION.length)] ?? 'eu-west'
    const what = WHAT[Math.floor(next() * WHAT.length)] ?? 'request finished'
    const ms = Math.floor(next() * 2000)
    const user = 1000 + Math.floor(next() * 9000)
    const line = `${level} [${who}@${region}] ${what} in ${String(ms)}ms user=${String(user)}`
    at += encoder.encodeInto(line, bytes.subarray(at)).written
    offsets[id + 1] = at
  }

  const packed = bytes.subarray(0, at)
  return {
    bytes: packed,
    offsets,
    length: count,
    size: packed.byteLength + offsets.byteLength,
    at: id =>
      decoder.decode(packed.subarray(offsets[id] ?? 0, offsets[id + 1] ?? offsets[id] ?? 0)),
  }
}

export interface Progress {
  readonly found: Line[]
  readonly total: number
  readonly seen: number
  readonly done: boolean
  readonly ms: number
  /**
   * Matches per hour of the day, as a typed array.
   *
   * Here because a screen wants to draw it, and because it is the thing З-6
   * asks about: bulk numbers crossing a wire ten times a second. A histogram
   * of twenty-four buckets is small; the page also builds a wide one on
   * demand, to show what the size does to the crossing.
   */
  readonly hist: Float64Array
}

/**
 * Where a pattern is looked for.
 *
 * A plain word is searched for in the bytes themselves — no line becomes a
 * string. Anything with regex punctuation needs a string to match against, so
 * those lines are decoded one at a time; that is slower, and the page says so.
 */
function bytesOf(needle: string): Uint8Array {
  return new TextEncoder().encode(needle)
}

const isRegex = (needle: string): boolean => /[\\^$.*+?()[\]{}|]/.test(needle)

export function* searching(
  log: Log,
  needle: string,
  chunk = 25_000,
  limit = 50,
  buckets = 24,
): Generator<Progress, Progress, undefined> {
  const started = performance.now()
  const found: Line[] = []
  const hist = new Float64Array(buckets)
  let total = 0
  let seen = 0

  if (needle === '') {
    return { found, total, seen: log.length, done: true, ms: 0, hist }
  }

  const asRegex = isRegex(needle)
  let re: RegExp | undefined
  if (asRegex) {
    try {
      re = new RegExp(needle)
    } catch {
      // Half a typed expression is a normal state of a text box, not an error.
      return { found, total, seen: log.length, done: true, ms: 0, hist }
    }
  }
  const target = asRegex ? undefined : bytesOf(needle)

  while (seen < log.length) {
    const end = Math.min(log.length, seen + chunk)
    for (let i = seen; i < end; i++) {
      const from = log.offsets[i] ?? 0
      const to = log.offsets[i + 1] ?? from
      let hit = false

      if (target === undefined) {
        hit = re?.test(log.at(i)) ?? false
      } else {
        // Plain text: look for the needle in the bytes, without making a string.
        const last = to - target.length
        for (let p = from; p <= last; p++) {
          let k = 0
          while (k < target.length && log.bytes[p + k] === target[k]) k++
          if (k === target.length) {
            hit = true
            break
          }
        }
      }

      if (!hit) continue
      total++
      // The bucket a line falls into: a stand-in for a real dimension, decided
      // by the line number so it costs nothing to compute.
      hist[i % buckets] = (hist[i % buckets] ?? 0) + 1
      // Only the lines that will be shown become strings.
      if (found.length < limit) found.push({ id: i, text: log.at(i) })
    }
    seen = end
    const step: Progress = {
      found: [...found],
      total,
      seen,
      done: seen >= log.length,
      ms: performance.now() - started,
      // A copy, because the running one keeps changing and what is published
      // has to stand still.
      hist: hist.slice(),
    }
    if (step.done) return step
    yield step
  }
  return { found, total, seen, done: true, ms: performance.now() - started, hist: hist.slice() }
}
