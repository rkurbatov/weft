// A table over a wire.
//
// Until now only cells crossed, so a table went whole on every edit: a hundred
// thousand rows because one of them changed. What crosses now is one snapshot
// and then what changed — the batches the table already records, carried
// across rather than invented here.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { atOnce, link, serve } from '#link'
import { subscribe, table, wirePair } from '#weft'
import type { Key } from '#weft'
import { settle, until } from '#testkit'

interface Row {
  id: number
  title: string
  [field: string]: unknown
}

const rowsOf = (mirror: { rows: { peek(): readonly unknown[] } }): Row[] =>
  [...mirror.rows.peek()] as Row[]

/** A station serving one table, and a panel following it. */
function pair() {
  const rows = table<Row>({ key: r => r.id as Key, name: 'rows' })
  const wire = wirePair()
  const stop = serve({ tables: { rows } }, wire.graph, { schedule: atOnce })
  const watcher = link(wire.watcher)
  return {
    rows,
    watcher,
    close: () => {
      stop()
      watcher.close()
      rows.dispose()
    },
  }
}

describe('following a table across a wire', () => {
  test('the rows arrive once, and then only what changed', async () => {
    const { rows, watcher, close } = pair()
    until(close)

    rows.put({ id: 1, title: 'one' }, { id: 2, title: 'two' })
    const mirror = watcher.table<Row>('rows')
    until(subscribe(mirror.rows, () => {}))
    await settle(3)

    assert.equal(mirror.cold.peek(), false, 'the snapshot landed')
    assert.deepEqual(
      rowsOf(mirror).map(r => r.title),
      ['one', 'two'],
    )

    rows.put({ id: 2, title: 'two again' })
    await settle(3)
    assert.deepEqual(
      rowsOf(mirror).map(r => r.title),
      ['one', 'two again'],
      'one row changed, and the other is the same object it was',
    )

    rows.drop(1)
    await settle(3)
    assert.deepEqual(
      rowsOf(mirror).map(r => r.id),
      [2],
      'a row that left is gone here too',
    )
  })

  test('an edit costs one row on the wire, not the table', async () => {
    const { rows, watcher, close } = pair()
    until(close)

    rows.put(...Array.from({ length: 2_000 }, (_, i) => ({ id: i, title: `row ${String(i)}` })))

    let carried = 0
    const mirror = watcher.table<Row>('rows')
    until(subscribe(mirror.rows, () => {}))
    await settle(3)
    assert.equal(rowsOf(mirror).length, 2_000)

    // Counted by what the mirror had to change, which is what the batch
    // carried: a whole-table send would have replaced every row.
    const before = rowsOf(mirror)
    rows.put({ id: 7, title: 'edited' })
    await settle(3)
    const after = rowsOf(mirror)

    for (const [i, row] of after.entries()) {
      if (row.id === 7) continue
      if (row === before[i]) carried++
    }
    assert.ok(carried > 1_900, `${String(2_000 - carried)} rows were replaced, not one`)
    assert.equal(after.find(r => r.id === 7)?.title, 'edited')
  })

  test('a lost batch is noticed and made up for, not applied blindly', async () => {
    const rows = table<Row>({ key: r => r.id as Key, name: 'rows' })
    until(() => rows.dispose())
    const wire = wirePair()
    until(serve({ tables: { rows } }, wire.graph, { schedule: atOnce }))

    // A channel that can be told to drop what the station sends.
    let dropping = false
    const lossy = {
      send: (message: unknown) => wire.watcher.send(message),
      listen: (handler: (message: unknown) => void) =>
        wire.watcher.listen(message => {
          const kind = (message as { kind?: string }).kind
          if (dropping && kind === 'changed') return
          handler(message)
        }),
    }
    const watcher = link(lossy)
    until(watcher.close)

    rows.put({ id: 1, title: 'one' })
    const mirror = watcher.table<Row>('rows')
    until(subscribe(mirror.rows, () => {}))
    until(subscribe(mirror.catchingUp, () => {}))
    await settle(3)
    assert.deepEqual(
      rowsOf(mirror).map(r => r.title),
      ['one'],
    )

    // A batch goes missing.
    dropping = true
    rows.put({ id: 2, title: 'two' })
    await settle(3)
    assert.deepEqual(
      rowsOf(mirror).map(r => r.title),
      ['one'],
      'the rows on screen are the last good ones',
    )

    // The next batch does not fit onto what this side has, so it asks to catch
    // up instead of applying changes onto a state they were not made for.
    dropping = false
    rows.put({ id: 3, title: 'three' })
    await settle(6)

    assert.deepEqual(
      rowsOf(mirror)
        .map(r => r.title)
        .toSorted(),
      ['one', 'three', 'two'],
      'everything is here after the catch-up',
    )
    assert.equal(mirror.catchingUp.peek(), false, 'and it says it is caught up')
  })

  test('nobody watching, nothing sent', async () => {
    const { rows, watcher, close } = pair()
    until(close)
    rows.put({ id: 1, title: 'one' })

    const mirror = watcher.table<Row>('rows')
    const stop = subscribe(mirror.rows, () => {})
    await settle(3)
    assert.equal(rowsOf(mirror).length, 1)

    stop()
    await settle(3)
    // The follow is dropped with the last watcher; what was here is forgotten,
    // because unknown is honest and stale is not.
    assert.equal(mirror.cold.peek(), true)
    assert.equal(rowsOf(mirror).length, 0)

    rows.put({ id: 2, title: 'two' })
    await settle(3)
    assert.equal(rowsOf(mirror).length, 0, 'and no batches arrive for nobody')
  })

  test('a table nobody published is refused by name', async () => {
    const { watcher, close } = pair()
    until(close)

    const mirror = watcher.table<Row>('nothing-like-this')
    until(subscribe(mirror.rows, () => {}))
    await settle(3)

    assert.equal(mirror.cold.peek(), true, 'nothing arrived, and nothing pretended to')
  })
})
