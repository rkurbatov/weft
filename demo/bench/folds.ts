// The carriers measured on the live table: one edit in a big collection,
// three ways to keep the answer.
//
//   pnpm demo:folds              200,000 rows
//   pnpm demo:folds --rows=1000000

import { table } from '#weft'
import { subscribe } from '#weft'

interface Row {
  id: number
  score: number
}

const arg = (name: string, fallback: number): number => {
  const found = process.argv.find(a => a.startsWith(`--${name}=`))
  return found === undefined ? fallback : Number(found.split('=')[1])
}
const N = arg('rows', 200_000)
const runs = arg('runs', 5)
const median = (xs: number[]): number =>
  xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)] as number

function scene(
  name: string,
  make: (t: ReturnType<typeof table<Row>>) => { peek: () => number },
): void {
  const times: number[] = []
  for (let run = 0; run <= runs; run++) {
    const t = table<Row>({ key: r => r.id })
    for (let from = 0; from < N; from += 10_000) {
      const page: Row[] = []
      for (let i = from; i < Math.min(from + 10_000, N); i++)
        page.push({ id: i, score: (i * 7919) % 1_000_003 })
      t.put(page)
    }
    const answer = make(t)
    const stop = subscribe(answer as never, () => {})
    answer.peek() // first build paid before the clock starts
    const at = performance.now()
    t.put({ id: 42, score: 2_000_000 })
    answer.peek()
    if (run > 0) times.push(performance.now() - at) // run 0 warms up, thrown away
    stop()
    t.dispose()
  }
  console.log(`${name.padEnd(46)} ${median(times).toFixed(2).padStart(8)} ms`)
}

console.log(
  `one edit in ${N.toLocaleString('en-US')} rows, median of ${runs}, ${process.version}\n`,
)
scene('sum, running (an inverse exists)', t =>
  t.fold({ zero: 0, add: (a, r) => a + r.score, sub: (a, r) => a - r.score }, 'sum'),
)
scene('max, tree (no inverse, partials join)', t =>
  t.fold({ zero: 0, add: (a, r) => Math.max(a, r.score), join: Math.max }, 'max.tree'),
)
scene('max, oracle (the same fold, forced slow)', t =>
  t.fold(
    { zero: 0, add: (a, r) => Math.max(a, r.score), join: Math.max, carrier: 'oracle' },
    'max.recount',
  ),
)
