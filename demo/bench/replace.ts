// Slow on purpose and slow in a way that matters: the last scene takes minutes,
// and that is the finding rather than the setup. Reading every key of a cache
// that sits exactly at its ceiling, in order, makes each read miss the key the
// previous admission just took — and under one-scan grace each of those
// admissions walks the whole cold set twice. See the note in family.ts.
//
// What second chance costs, on the two shapes that matter: many reads of a
// cache that is holding, and one admission after a big working set has been
// read. The second is the one that moves — the work spread over the reads
// gathers into the pass that follows them.

import { family } from '#graph'

const members = 500_000
const reads = 1_000_000

const gc = (globalThis as { gc?: () => void }).gc
const heap = (): number => {
  gc?.()
  return process.memoryUsage().heapUsed
}

const build = (max: number, fill: number) => {
  const item = family((id: number) => id, { max })
  for (let i = 0; i < fill; i++) item(i)
  return item
}

const readsOver = (fill: number, label: string): void => {
  const item = build(members, fill)
  const started = performance.now()
  for (let i = 0; i < reads; i++) item(i % fill)
  console.log(`${label.padEnd(28)} ${(performance.now() - started).toFixed(1).padStart(8)} ms`)
}

readsOver(members / 2, `${reads.toLocaleString()} reads, half full`)
readsOver(members, `${reads.toLocaleString()} reads, full`)

// Built last and on its own: three families of half a million members alive in
// one process measure the collector, not the cache.
const before = heap()
const held = build(members, members)
const grew = ((heap() - before) / 1024 / 1024).toFixed(2)
console.log(`${members.toLocaleString()} members: ${grew} MB`)

// Touch everything, then ask for one more key. Several rounds, and both the
// middle and the worst of them: this is the number that moved when the policy
// changed, and one sample of it says nothing about a frame budget.
const admissions: number[] = []
const touches: number[] = []
for (let round = 0; round < 3; round++) {
  const touched = performance.now()
  for (let i = 0; i < members; i++) held(i)
  touches.push(performance.now() - touched)
  const admitted = performance.now()
  held(members + round + 1)
  admissions.push(performance.now() - admitted)
}
const middle = (of: number[]): number =>
  of.toSorted((a, b) => a - b)[Math.floor(of.length / 2)] ?? 0
const worst = (of: number[]): number => Math.max(...of)
console.log(
  `touch all: median ${middle(touches).toFixed(1)} ms, worst ${worst(touches).toFixed(1)} ms`,
)
console.log(
  `next admission: median ${middle(admissions).toFixed(1)} ms, ` +
    `worst ${worst(admissions).toFixed(1)} ms`,
)
