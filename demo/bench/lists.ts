// A long list of unequal rows: the cached-offsets way against the block tree.
//
//   pnpm demo:list                 100,000 rows
//   pnpm demo:list --rows=1000000  a million
//
// Four scenes, each the thing a real list actually does:
//   scroll far     — jump to the middle and ask what is there
//   one measured   — an image arrives near the top and one row grows
//   many measured  — a screenful of rows report their real heights
//   fed from top   — a live feed pushes a hundred rows in above
//
// The last subject, `scan through rel`, reaches the same flat carrier by
// declaring a scan rather than calling a structure; its scenes are translated
// into the edits an application would make, so it measures the layer's price,
// not another algorithm.

import { classicList } from './list/classic.ts'
import { weftList } from './list/weft.ts'
import { flatList } from './list/flat.ts'
import { scanList } from './list/scan.ts'
import type { List } from './list/classic.ts'

/** The longest of a set of widths, folded rather than spread. */
const widest = (widths: readonly number[]): number =>
  widths.reduce((most, one) => (one > most ? one : most), 0)

const arg = (name: string, fallback: number): number => {
  const found = process.argv.find(a => a.startsWith(`--${name}=`))
  return found === undefined ? fallback : Number(found.split('=')[1])
}

const rowCount = arg('rows', 100_000)
const runs = arg('runs', 3)

/** Heights a real list has: mostly one line, sometimes three, rarely a photo. */
function heights(count: number): number[] {
  const out: number[] = []
  let seed = 12_345
  for (let i = 0; i < count; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const roll = seed % 100
    out.push(roll < 70 ? 48 : roll < 95 ? 96 : 320)
  }
  return out
}

const rows = heights(rowCount)
const total = rows.reduce((a, b) => a + b, 0)

interface Scene {
  name: string
  run: (list: List) => void
}

const scenes: Scene[] = [
  {
    name: 'scroll far',
    run: list => {
      list.at(Math.floor(total * 0.6))
    },
  },
  {
    name: 'one row measured',
    run: list => {
      list.measure(20, 320)
      list.at(Math.floor(total * 0.6))
    },
  },
  {
    name: 'a screenful measured',
    run: list => {
      for (let i = 100; i < 130; i++) list.measure(i, 96)
      list.at(Math.floor(total * 0.6))
    },
  },
  {
    name: 'a hundred fed in on top',
    run: list => {
      list.prepend(heights(100))
      list.at(Math.floor(total * 0.6))
    },
  },
]

const subjects: Array<{ name: string; open: () => List }> = [
  { name: 'cached offsets', open: () => classicList(rows) },
  { name: 'graph tree', open: () => weftList(rows) },
  { name: 'flat tree, delta-fed', open: () => flatList(rows) },
  // Same carrier underneath, declared instead of called: the layer's price.
  { name: 'scan through rel', open: () => scanList(rows) },
]

const median = (xs: number[]): number =>
  xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)] as number
const ms = (v: number): string => (v >= 100 ? v.toFixed(0) : v.toFixed(2))
const count = (v: number): string => v.toLocaleString('en-US')

function table(lines: string[][]): string {
  const widths = (lines[0] ?? []).map((_h, col) =>
    widest(lines.map(line => (line[col] ?? '').length)),
  )
  return lines
    .map(line =>
      line.map((cell, col) => cell.padStart((widths[col] ?? 0) + (col === 0 ? 0 : 3))).join(''),
    )
    .join('\n')
}

console.log(
  `list of ${count(rowCount)} rows, unequal heights, median of ${runs} run${runs === 1 ? '' : 's'}, ${process.version}\n`,
)

for (const scene of scenes) {
  console.log(scene.name)
  const lines: string[][] = [['', 'time', 'rows added up', 'vs cached']]
  let baseline = 0

  for (const subject of subjects) {
    const times: number[] = []
    let walked = 0
    // One run thrown away: whoever goes first would pay for the warm-up.
    {
      const list = subject.open()
      scene.run(list)
      list.close?.()
    }
    for (let run = 0; run < runs; run++) {
      const list = subject.open()
      list.at(0) // both start from a screen at the top, as a real list does
      list.resetWalked()
      const at = performance.now()
      scene.run(list)
      times.push(performance.now() - at)
      walked = list.walked()
      list.close?.()
    }
    const took = median(times)
    if (subject.name === 'cached offsets') baseline = took
    lines.push([
      subject.name,
      `${ms(took)} ms`,
      count(walked),
      baseline === 0 ? '—' : `${(baseline / took).toFixed(1)}x`,
    ])
  }

  console.log(table(lines))
  console.log()
}
