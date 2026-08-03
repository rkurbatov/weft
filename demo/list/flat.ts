// The third way: a flat Fenwick tree over plain numbers, fed by deltas
// directly. No graph, no cache to invalidate — a measure is a point update in
// O(log n), an offset is a prefix sum in O(log n), a hit test descends the
// tree. This is what the granularity law prescribes for small elements in a
// crowd; the graph holds one version cell in a real app, none here.

import type { List } from './classic.ts'

export function flatList(heights: number[]): List {
  let n = heights.length
  let tree: Float64Array // 1-based Fenwick
  let rows: number[]
  let walked = 0

  const build = (from: number[]): void => {
    n = from.length
    rows = from.slice()
    tree = new Float64Array(n + 1)
    for (let i = 0; i < n; i++) {
      walked++
      tree[i + 1] = (tree[i + 1] as number) + (from[i] as number)
      const up = i + 1 + ((i + 1) & -(i + 1))
      if (up <= n) tree[up] = (tree[up] as number) + (tree[i + 1] as number)
    }
  }
  build(heights)

  const prefix = (count: number): number => {
    let sum = 0
    for (let i = count; i > 0; i -= i & -i) sum += tree[i] as number
    return sum
  }

  return {
    offsetOf: index => prefix(index),

    at(pixel) {
      // Descend the tree: find the last index whose prefix is <= pixel.
      let index = 0
      let rest = pixel
      let step = 1 << (31 - Math.clz32(n || 1))
      for (; step > 0; step >>= 1) {
        const next = index + step
        if (next <= n && (tree[next] as number) <= rest) {
          index = next
          rest -= tree[next] as number
        }
      }
      const at = Math.min(index, n - 1)
      return { index: at, into: pixel - prefix(at) }
    },

    measure(index, height) {
      const delta = height - (rows[index] as number)
      if (delta === 0) return
      rows[index] = height
      for (let i = index + 1; i <= n; i += i & -i) {
        walked++
        tree[i] = (tree[i] as number) + delta
      }
    },

    prepend(fresh) {
      build([...fresh, ...rows])
    },

    size: () => n,
    walked: () => walked,
    resetWalked: () => {
      walked = 0
    },
  }
}
