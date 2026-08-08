// What the three kanban examples share: the server they all talk to, the words
// its board is made of, and the markup they all draw.
//
// Reached as '#kanban'. Three examples solving one task with different tools
// only prove anything if the task is literally the same code.

export { kanbanServer } from './server.ts'
export type { KanbanServer, ServerOptions } from './server.ts'
export type { BoardSnapshot, Card, ColumnData, Tag } from './types.ts'

// The board's markup stays out of this door: a test runs in Node, where a
// .tsx cannot be loaded, and three of them broke the moment it was in here.
// Screens take it as '#kanban/board.tsx'.
