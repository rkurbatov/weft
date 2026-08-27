// What second chance costs, on the two shapes that matter: many reads of a
// cache that is holding, and one admission after a big working set has been
// read. The second is the one that moves — the work spread over the reads
// gathers into the pass that follows them.

import { family } from '#graph'

const members = 500_000
const reads = 5_000_000

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

const before = heap()
const held = build(members, members)
const grew = ((heap() - before) / 1024 / 1024).toFixed(2)
console.log(`${members.toLocaleString()} members: ${grew} MB`)

readsOver(members / 2, `${reads.toLocaleString()} reads, half full`)
readsOver(members, `${reads.toLocaleString()} reads, full`)

// touch everything, then ask for one more key
const touched = performance.now()
for (let i = 0; i < members; i++) held(i)
const touchedIn = performance.now() - touched
const admitted = performance.now()
held(members + 1)
const admittedIn = performance.now() - admitted
console.log(`touch all ${touchedIn.toFixed(1)} ms, then one admission ${admittedIn.toFixed(1)} ms`)
