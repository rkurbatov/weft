// A measured line: where things stand along it, and answers over ranges of it.
//
// Not rows with a key — a line of measured places. Virtualisation asks where
// row 4000 starts and which row sits at pixel 91240; a long document asks for
// the answer over a range of it. Both questions are about position along a
// line, and neither needs identity, so they live here rather than inside the
// table: the table is about keys, and these two never were.
//
// Below the granularity law: no cell per element. The carriers are a flat
// prefix tree and a tree of partial answers, and what watches them is one
// version cell above, not machinery inside.

export { offsets } from './offsets.ts'
export type { Offsets } from './offsets.ts'
export { blocks } from './blocks.ts'
export type { Blocks, BlockOptions } from './blocks.ts'
export { anchorShift } from './anchor.ts'
export type { Anchor } from './anchor.ts'
