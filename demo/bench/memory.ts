// What the observation seam costs in memory, in the two shapes that matter:
// cells that never asked for it, and a family that did.

import { derived, family, port } from '#graph'

const gc = (globalThis as { gc?: () => void }).gc
const heap = (): number => {
  gc?.()
  return process.memoryUsage().heapUsed
}

const held: unknown[] = []
const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)} MB`

const plain = 300_000
let before = heap()
const source = port(1)
for (let i = 0; i < plain; i++) held.push(derived(() => source.get()))
console.log(`${plain.toLocaleString()} ordinary cells: ${mb(heap() - before)}`)

const members = 500_000
const item = family((id: number) => id, { max: members })
before = heap()
for (let i = 0; i < members; i++) item(i)
console.log(`${members.toLocaleString()} family members: ${mb(heap() - before)}`)
console.log(held.length, item.size)
