// The surface, kept as a type across the wire.
//
// The runtime path is the same one `link` already takes and has its own tests;
// what is checked here is what used to be checked by nothing — that the names
// and the types survive the crossing.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { faced, link, serve } from '#link'
import { atOnce, wirePair } from '#wire'
import { port, subscribe, table } from '#weft'
import { settle, until } from '#testkit'

interface Seat {
  readonly id: number
  readonly who: string
}

const world = () => {
  const seats = port(1, { name: 'typed.seats' })
  const rows = table<Seat>({ name: 'typed.rows', key: row => row.id })
  rows.put({ id: 1, who: 'ann' })
  const surface = {
    cells: { seats },
    commands: { take: (many: number): number => seats.peek() + many },
    tables: { rows },
  }
  return { seats, rows, surface }
}

describe('a surface that keeps its type', () => {
  test('a declared cell arrives typed, without being named twice', async () => {
    const { surface } = world()
    const wire = wirePair()
    until(serve(surface, wire.graph, { schedule: atOnce }))
    const station = faced<typeof surface>(link(wire.watcher))

    const seats = station.cells.seats
    // A mirror is fed while somebody watches it, exactly as a screen would.
    until(subscribe(seats, () => {}))
    await settle()

    const held = seats.peek()
    // `Remote<number>` and not `Remote<unknown>`: the value below is a number
    // because the station said so, not because this line says so.
    const value: number | undefined = held.kind === 'value' ? held.value : undefined
    assert.equal(value, 1)
    station.close()
  })

  test('a declared command keeps its arguments and its answer', async () => {
    const { surface } = world()
    const wire = wirePair()
    until(serve(surface, wire.graph, { schedule: atOnce }))
    const station = faced<typeof surface>(link(wire.watcher))

    const answer: number = await station.commands.take(2)
    assert.equal(answer, 3, 'the number came back a number')
    station.close()
  })

  test('a declared table mirrors its rows', async () => {
    const { surface } = world()
    const wire = wirePair()
    until(serve(surface, wire.graph, { schedule: atOnce }))
    const station = faced<typeof surface>(link(wire.watcher))

    const mirror = station.tables.rows
    until(subscribe(mirror.rows, () => {}))
    await settle()
    const rows: readonly Seat[] = mirror.rows.peek()
    assert.equal(rows[0]?.who, 'ann')
    station.close()
  })
})
