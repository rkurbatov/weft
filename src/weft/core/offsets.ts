// An ordered line of measured rows: where each one stands, and which one is at
// a given point. This is what virtualisation asks a hundred times per scroll —
// offsets for placing rows, a hit test for the viewport.
//
// The carrier is a flat Fenwick tree over plain numbers, fed by deltas: a row
// measured anew is a point update in O(log n), an offset is a prefix sum in
// O(log n), a hit test descends the tree. No cell per row — the granularity
// law forbids graph machinery on elements this small; in a live app the graph
// holds one version cell above this line, none inside it.
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
  let tree = new Float64Array(0) // 1-based Fenwick, built lazily
  let stale = true
  let worked = 0

  const rebuild = (): void => {
    n = sizes.length
    tree = new Float64Array(n + 1)
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
      // Not splice(...fresh): a big batch as call arguments overflows the stack.
      const at = Math.max(0, Math.min(index, sizes.length))
      sizes = [...sizes.slice(0, at), ...fresh, ...sizes.slice(at)]
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
