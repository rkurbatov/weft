// What identifies a row. A string or a number: whatever survives a trip through
// a wire, a disk and a JSON, and whatever two implementations agree on.

export type Key = string | number
