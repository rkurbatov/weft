// What bulk numbers cost on the way to a panel.
//
// The order (item 6) asks whether histograms and heat maps should be handed
// by ownership instead of copied. The answer is a number, and it depends on
// two things: how big the array is, and how often it is sent. Both are here.
//
//   pnpm demo:wire
//   pnpm demo:wire --buckets=100000 --pace=100

import { MessageChannel } from 'node:worker_threads'

/** The middle of a set of timings: one run in twenty is noise, not a number. */
const median = (values: number[]): number =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0

const arg = (name: string, fallback: number): number => {
  const found = process.argv.find(a => a.startsWith(`--${name}=`))
  return found === undefined ? fallback : Number(found.slice(name.length + 3))
}

const pace = arg('pace', 100)
const rounds = 30

interface Row {
  readonly what: string
  readonly bytes: number
  readonly copy: number
  readonly handed: number
}

async function measure(buckets: number): Promise<Row> {
  const { port1, port2 } = new MessageChannel()
  port2.on('message', () => {})
  const source = new Float64Array(buckets).map((_, i) => i)

  const copies: number[] = []
  for (let i = 0; i < rounds; i++) {
    const value = source.slice()
    const started = performance.now()
    port1.postMessage(value)
    copies.push(performance.now() - started)
  }

  const handed: number[] = []
  for (let i = 0; i < rounds; i++) {
    const value = source.slice()
    const started = performance.now()
    port1.postMessage(value, [value.buffer])
    handed.push(performance.now() - started)
  }

  port1.close()
  port2.close()
  return {
    what: `${buckets.toLocaleString('en')} numbers`,
    bytes: buckets * 8,
    copy: median(copies),
    handed: median(handed),
  }
}

const rows: Row[] = []
for (const buckets of [24, 1_000, 100_000, 1_000_000, 4_000_000]) {
  // One at a time on purpose: two measurements at once measure each other.
  // oxlint-disable-next-line no-await-in-loop
  rows.push(await measure(buckets))
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)} MB`
const ms = (value: number): string => `${value.toFixed(3)} ms`

console.log(`\nOne send, and a second of them at a pace of ${String(pace)}ms:\n`)
console.log(
  [
    'array'.padEnd(20),
    'size'.padStart(9),
    'copy'.padStart(10),
    'handed over'.padStart(12),
    'copying costs'.padStart(18),
  ].join(''),
)
for (const row of rows) {
  const perSecond = (row.copy * 1000) / pace
  console.log(
    [
      row.what.padEnd(21),
      mb(row.bytes).padStart(10),
      ms(row.copy).padStart(12),
      ms(row.handed).padStart(13),
      `${perSecond.toFixed(0)} of 1000 ms`.padStart(18),
    ].join(''),
  )
}
console.log(
  `\nThe last column is what copying costs out of every second at that pace —\n` +
    `a thousand milliseconds is the whole of it.\n`,
)
