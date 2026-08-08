// An ordered line of measured rows: where each one stands, and which one is at
// a given point. This is what virtualisation asks a hundred times per scroll —
// offsets for placing rows, a hit test for the viewport.
//
// The carrier is a flat Fenwick tree over plain numbers, fed by deltas: a row
// measured anew is a point update in O(log n), an offset is a prefix sum in
// O(log n), a hit test is a binary lift straight down the same array. No cell
// per row — the granularity law forbids graph machinery on elements this
// small; in a live app the graph holds one version cell above this line, none
// inside it.
//
// Flat on purpose: one Float64Array instead of a tree of node objects. A
// reference tree scatters a hundred thousand nodes across the heap — every
// step of a query is a pointer chase and a likely cache miss, and every
// rebalance allocates. Here a query walks indices in one contiguous buffer,
// updates allocate nothing, and the structural shift on insert — O(n) over a
// packed array of doubles — beats a balanced tree's bookkeeping in practice
// at every size a screen can hold.
//
// Structure changes (rows entering or leaving) shift every index, so they only
// mark the tree stale; it is rebuilt once, at the first question after — a
// burst of insertions costs one rebuild, not one per batch. Measurements keep
// landing while the tree is stale and are simply part of that rebuild.

export interface Offsets {
  /** Where row `index` starts — the sum of every size before it. */
  offsetOf(index: number): number
  /** Which row is at `point`, and how far into it. A point past the end lands
   *  on the last row (overscan clamps); an empty line answers index -1. */
  at(point: number): { index: number; into: number }
  /** The whole line's extent. */
  total(): number
  size(): number
  /** Row `index` was measured anew — an image arrived, text wrapped. A row
   *  that has already left the line is ignored: screens report late. */
  measure(index: number, size: number): void
  /** New rows enter before `index`, pushing the rest down. */
  insert(index: number, sizes: readonly number[]): void
  /** `count` rows leave at `index`. */
  remove(index: number, count?: number): void
  /** The whole picture anew. */
  replace(sizes: readonly number[]): void
  /** Additions walked since the last reset — for benchmarks, not for logic. */
  worked(): number
  resetWorked(): void
}

export function offsets(initial: readonly number[] = []): Offsets {
  let sizes: number[] = initial.slice()
  let n = sizes.length
  // 1-based Fenwick, built lazily and grown with room to spare, so that rows
  // arriving one at a time do not each cost a new array.
  let tree = new Float64Array(0)
  let stale = true
  let worked = 0

  const rebuild = (): void => {
    n = sizes.length
    // Half again as much room: appending stays cheap for a while after every
    // rebuild, and the slack is one number per row at worst.
    tree = new Float64Array(Math.max(n + 1, Math.ceil(n * 1.5) + 1))
    for (let i = 0; i < n; i++) {
      worked++
      tree[i + 1] = (tree[i + 1] as number) + (sizes[i] as number)
      const up = i + 1 + ((i + 1) & -(i + 1))
      if (up <= n) tree[up] = (tree[up] as number) + (tree[i + 1] as number)
    }
    stale = false
  }

  const ensure = (): void => {
    if (stale) rebuild()
  }

  const prefix = (count: number): number => {
    let sum = 0
    for (let i = count; i > 0; i -= i & -i) sum += tree[i] as number
    return sum
  }

  return {
    offsetOf(index) {
      ensure()
      return prefix(Math.max(0, Math.min(index, n)))
    },

    at(point) {
      ensure()
      if (n === 0) return { index: -1, into: point }
      // Descend: the last index whose prefix is <= point.
      let index = 0
      let rest = point
      let step = 1 << (31 - Math.clz32(n))
      for (; step > 0; step >>= 1) {
        const next = index + step
        if (next <= n && (tree[next] as number) <= rest) {
          index = next
          rest -= tree[next] as number
        }
      }
      const found = Math.min(index, n - 1)
      return { index: found, into: point - prefix(found) }
    },

    total() {
      ensure()
      return prefix(n)
    },

    size: () => sizes.length,

    measure(index, size) {
      if (index < 0 || index >= sizes.length) return
      const delta = size - (sizes[index] as number)
      if (delta === 0) return
      sizes[index] = size
      if (stale) return // the rebuild will pick it up
      for (let i = index + 1; i <= n; i += i & -i) {
        worked++
        tree[i] = (tree[i] as number) + delta
      }
    },

    insert(index, fresh) {
      if (fresh.length === 0) return
      const at = Math.max(0, Math.min(index, sizes.length))
      // Rows landing at the end — a feed, a log, a page of results — extend
      // the tree instead of retiring it. Without this a screen that reads
      // between arrivals pays a full rebuild per row, and that, not the array
      // itself, was the expensive part: appending cost as much as prepending.
      if (!stale && at === sizes.length && tree.length > n) {
        for (const size of fresh) {
          sizes.push(size)
          const i = ++n
          // A Fenwick node covers the last `lowbit(i)` sizes; both prefixes it
          // is made of are already true, since they end before i.
          const low = i & -i
          tree[i] = prefix(i - 1) - prefix(i - low) + size
          worked++
        }
        return
      }
      if (!stale && at === sizes.length) {
        // The tree has no room to grow into: fall through to a rebuild.
        stale = true
      }
      // In place, in chunks. Not `splice(at, 0, ...fresh)`: a big batch passed
      // as call arguments overflows the stack. And not three new arrays: that
      // copied the whole line on every insertion, so a list filled one row at
      // a time cost the square of its length.
      const STEP = 8192
      for (let from = 0; from < fresh.length; from += STEP) {
        const part = fresh.slice(from, from + STEP)
        sizes.splice(at + from, 0, ...part)
      }
      stale = true
    },

    remove(index, count = 1) {
      if (index < 0 || index >= sizes.length || count <= 0) return
      sizes.splice(index, count)
      stale = true
    },

    replace(fresh) {
      sizes = fresh.slice()
      stale = true
    },

    worked: () => worked,
    resetWorked: () => {
      worked = 0
    },
  }
}
