import { test } from 'node:test'
import assert from 'node:assert/strict'
import { kanbanServer } from '#kanban'
import { makeStore } from './store.ts'
import { appStop, boardLoad, cardMove } from './actions.ts'

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

test('load fills the normalized shape', async () => {
  const store = makeStore(kanbanServer({ latency: 3 }), 60_000)
  store.dispatch(boardLoad())
  await wait(30)
  const board = store.getState().board
  assert.equal(board.loading, false)
  assert.deepEqual(board.columnOrder, ['backlog', 'progress', 'review', 'done'])
  assert.equal(board.columns['backlog']?.cardIds.length, 9)
  assert.equal(Object.keys(board.cards).length, 20)
  store.dispatch(appStop())
})

test('a refused move shows up instantly and rolls back to where it stood', async () => {
  const store = makeStore(kanbanServer({ latency: 10, grumpiness: 1 }), 60_000)
  store.dispatch(boardLoad())
  await wait(40)
  const before = store.getState().board.columns['backlog']?.cardIds ?? []
  const moved = before[2]
  assert.ok(moved !== undefined)

  store.dispatch(cardMove(moved, 'review', 0))
  let board = store.getState().board
  assert.equal(board.columns['review']?.cardIds[0], moved) // optimistic, no waiting
  assert.ok(board.pendingMoves[moved] !== undefined)

  await wait(40) // the server refuses
  board = store.getState().board
  assert.deepEqual(board.columns['backlog']?.cardIds, before)
  assert.equal(board.pendingMoves[moved], undefined)
  assert.ok(board.notice !== null)
  store.dispatch(appStop())
})

test('an accepted move stays', async () => {
  const store = makeStore(kanbanServer({ latency: 3, grumpiness: 0 }), 60_000)
  store.dispatch(boardLoad())
  await wait(30)
  const moved = store.getState().board.columns['backlog']?.cardIds[0]
  assert.ok(moved !== undefined)
  store.dispatch(cardMove(moved, 'progress', 1))
  await wait(30)
  const board = store.getState().board
  assert.equal(board.columns['progress']?.cardIds[1], moved)
  assert.deepEqual(board.pendingMoves, {})
  store.dispatch(appStop())
})

test('polling picks up the bot: the silent reload brings a newer board', async () => {
  const server = kanbanServer({ latency: 2, grumpiness: 0, botEvery: 15 })
  const stopBot = server.startBot()
  const store = makeStore(server, 25)
  store.dispatch(boardLoad())
  await wait(20)
  const was = store.getState().board.version
  await wait(150)
  stopBot()
  store.dispatch(appStop())
  assert.ok(store.getState().board.version > was)
})
