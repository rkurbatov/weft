// A measured line: where things stand along it, and answers over ranges of it.
//
// Virtualisation asks where row four thousand starts and which row sits at a
// pixel; a long document asks for a total over a range. Neither question is
// about identity, which is why they are not the table's.

export { anchorShift, blocks, offsets } from '#line'
export type { Anchor, BlockOptions, Blocks, Offsets } from '#line'
