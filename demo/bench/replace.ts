// What CLOCK second chance costs, on the two shapes that matter: a working set
// read again while the cache is holding, and a scan of a cache standing exactly
// at its ceiling, where every read misses the key the last admission took and so
// is itself an admission.
//
// The second shape is the one that moves. While a pass began at the oldest cold
// member it built a fresh iterator over a map whose head kept being deleted,
// which V8 pays for by walking the deleted slots — quadratic in the size of the
// set, minutes on half a million members. The hand does not begin anywhere: it
// stands where the last pass left it.
//
// Both bands run at n and 2n, because the finding is a growth and not a
// threshold: twice the members must be about twice the time.
//
// Small by default. `--full` is the whole witness, and `--expose-gc` is needed
// for the memory line:
//
//   node --expose-gc demo/bench/replace.ts --full

import { family } from '#graph'
import { blocks } from '#line'

const flag = (name: string, fallback: number): number => {
  const given = process.argv.find(arg => arg.startsWith(`--${name}=`))
  return given === undefined ? fallback : Number(given.slice(name.length + 3))
}
const full = process.argv.includes('--full')
// Partials are heavier than plain members and there are two levels of them, so
// the full witness asks for fewer.
const members = flag('members', full ? 500_000 : 20_000)
const partials = flag('partials', full ? 100_000 : 20_000)
const rounds = flag('rounds', 3)

const middle = (of: number[]): number => of.toSorted((a, b) => a - b)[of.length >> 1] ?? 0
const worst = (of: number[]): number => of.reduce((most, one) => (one > most ? one : most), 0)
const say = (label: string, ms: number[]): void => {
  console.log(
    `  ${label.padEnd(26)} median ${middle(ms).toFixed(1).padStart(9)} ms   ` +
      `worst ${worst(ms).toFixed(1).padStart(9)} ms`,
  )
}
const count = (label: string, of: number[]): void => {
  console.log(`  ${label.padEnd(26)} median ${String(middle(of)).padStart(9)}`)
}

/** A family of plain members: the policy on its own, with nothing else in the way. */
const synthetic = (n: number): void => {
  console.log(`\nfamily: ${n.toLocaleString()} members, ceiling ${n.toLocaleString()}`)
  const scans: number[] = []
  const admissions: number[] = []
  const races: number[] = []
  for (let round = 0; round < rounds; round++) {
    const item = family((id: number) => id, { max: n })
    for (let i = 0; i < n; i++) item(i)

    let started = performance.now()
    for (let i = 0; i < n; i++) item(i) // every read a hit: one store each
    scans.push(performance.now() - started)

    started = performance.now()
    item(n) // one key too many, over a set that has just been read whole
    admissions.push(performance.now() - started)

    started = performance.now()
    for (let i = 0; i < n; i++) item(i) // every read a miss, so every read admits
    races.push(performance.now() - started)
  }
  say('scan, every read a hit', scans)
  say('admission after that scan', admissions)
  say('scan, every read a miss', races)
}

/**
 * The same two shapes on a real client: a fold over a long line, where each
 * root is one block's partial answer and a range asks for one of them.
 */
const client = (n: number): void => {
  console.log(`\nblocks.range: ${n.toLocaleString()} roots, ceiling ${n.toLocaleString()}`)
  const span = 32
  const scans: number[] = []
  const races: number[] = []
  const admissions: number[] = []
  const scanWork: number[] = []
  const raceWork: number[] = []
  for (let round = 0; round < rounds; round++) {
    const fold = blocks<number>({
      read: (_line, at) => at & 7,
      zero: 0,
      join: (a, b) => a + b,
      span,
      max: n,
    })
    const over = (index: number): number =>
      fold.range('line', index * span, index * span + span - 1)
    for (let i = 0; i < n; i++) over(i)

    fold.resetWorked()
    let started = performance.now()
    for (let i = 0; i < n; i++) over(i)
    scans.push(performance.now() - started)
    scanWork.push(fold.worked())

    started = performance.now()
    over(n)
    admissions.push(performance.now() - started)

    fold.resetWorked()
    started = performance.now()
    for (let i = 0; i < n; i++) over(i)
    races.push(performance.now() - started)
    raceWork.push(fold.worked())
  }
  say('scan, every read a hit', scans)
  count('partials worked', scanWork)
  say('admission after that scan', admissions)
  say('scan, every read a miss', races)
  count('partials worked', raceWork)
}

/**
 * What the ring itself costs. Built last and on its own: several families of
 * half a million members alive in one process measure the collector, not the
 * cache.
 */
const held = (n: number): void => {
  const gc = (globalThis as { gc?: () => void }).gc
  if (gc === undefined) {
    console.log('\nrun with --expose-gc for what the members weigh')
    return
  }
  // The least of several collections: one gc after four bands of garbage leaves
  // enough behind to swamp the two pointers this is here to price.
  const heap = (): number => {
    let least = Number.POSITIVE_INFINITY
    for (let i = 0; i < 4; i++) {
      gc()
      least = Math.min(least, process.memoryUsage().heapUsed)
    }
    return least
  }
  const before = heap()
  const item = family((id: number) => id, { max: n })
  for (let i = 0; i < n; i++) item(i)
  const grew = heap() - before
  console.log(
    `\n${n.toLocaleString()} members: ${(grew / 1024 / 1024).toFixed(1)} MB` +
      `, ${(grew / n).toFixed(1)} bytes each (${item.size} held)`,
  )
}

synthetic(members)
synthetic(members * 2)
client(partials)
client(partials * 2)
held(members)
