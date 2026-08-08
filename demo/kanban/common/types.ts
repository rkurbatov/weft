// The board as both sides see it. One vocabulary, one wire format.

export type Tag = 'bug' | 'feature' | 'chore'

export interface Card {
  id: string
  title: string
  tag: Tag
}

export interface ColumnData {
  id: string
  title: string
  /** Cards in board order, top to bottom. */
  cardIds: string[]
  /** More than this many cards is a smell the header points at. */
  limit: number
}

export interface BoardSnapshot {
  columns: ColumnData[]
  cards: Card[]
  version: number
}
