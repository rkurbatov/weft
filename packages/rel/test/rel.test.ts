// Beside the code because it checks the layer's internal thresholds — when a
// join is called crowded — along with everything the door does offer.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { subscribe } from '#weft'
import { table } from '#weft'
import type { SourceTable } from '#weft'
import type { Key } from '#weft'
import {
  agg,
  and,
  canonExpr,
  checkNode,
  cmp,
  evalExpr,
  expand,
  field,
  filter,
  join,
  keyOfRow,
  keyPaths,
  lit,
  math,
  oracle,
  param,
  paramsOfNode,
  pure,
  scan,
  some,
  source,
  union,
  whyRow,
} from '#rel'
import type { Row } from '#rel'
import { relate } from '#rel'
import { CROWDED_KEY } from '#rel/runners/join.ts'
import { onNotice } from '#data'
import { held as owned, until } from '#testkit'

describe('the relational layer', () => {
  const sale = (id: number, qty: number, price: number): Row => ({ id, qty, price })

  /** A source table of the relational layer, disposed of when the test ends. */
  function feed(name: string): SourceTable<Row> {
    return owned(table<Row>({ key: r => r['id'] as Key, name }))
  }

  /** A live relation over the given tables, disposed of when the test ends. */
  function living(tree: Parameters<typeof relate>[0], tables: Parameters<typeof relate>[1]) {
    return owned(relate(tree, tables))
  }

  test('expressions: data in, JS semantics out, canon stable across key order', () => {
    const row = { qty: 3, price: 10, tag: null }
    assert.equal(evalExpr(math('*', field('qty'), field('price')), row), 30)
    assert.equal(evalExpr(cmp('>', field('qty'), lit(2)), row), true)
    assert.equal(
      evalExpr(and(cmp('>', field('qty'), lit(2)), cmp('==', field('tag'), lit(null))), row),
      true,
    )
    assert.equal(evalExpr(field('missing', 'deeper'), row), undefined)
    assert.equal(canonExpr(math('+', lit(1), field('a', 'b'))), '(1+.a.b)')
  })

  test('oracle parity: the live chain answers like a oracle, at every step', () => {
    const sales = feed('sales')
    const tree = pure(filter(source('sales', ['id']), cmp('>', field('qty'), lit(0))), {
      fields: { total: math('*', field('qty'), field('price')) },
      pick: ['id', 'total'],
    })
    const live = living(tree, { sales })
    until(subscribe(live.all, () => {}))

    const check = (): void => {
      const rows = new Map<Key, Row>()
      for (const r of sales.all.peek()) rows.set(r['id'] as Key, r)
      const truth = oracle(tree, { sales: rows })
      const got = live.all.peek()
      assert.equal(got.length, truth.size)
      for (const row of got) assert.deepEqual(row, truth.get(row['id'] as Key))
    }

    let seed = 7
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let step = 0; step < 300; step++) {
      const id = rand(40)
      const move = rand(3)
      if (move === 0) sales.put(sale(id, rand(7) - 2, 1 + rand(9)))
      else if (move === 1) sales.drop(id)
      else sales.put(sale(id, rand(7) - 2, 1 + rand(9)))
      check()
    }
  })

  test('an edit pays as the edit: dead rows are silent, one move is one wake', () => {
    const sales = feed('sales')
    for (let i = 0; i < 100; i++) sales.put(sale(i, i % 2 === 0 ? 5 : -1, 10))
    const live = living(filter(source('sales', ['id']), cmp('>', field('qty'), lit(0))), { sales })

    let wakes = 0
    until(subscribe(live.all, () => wakes++))

    wakes = 0
    sales.put(sale(1, -5, 99)) // was out, stays out
    assert.equal(wakes, 0, 'a change among the filtered-out never reaches the screen')

    sales.put(sale(2, 7, 10)) // stays in, qty moved
    assert.equal(wakes, 1)
    assert.equal((live.row(2).peek() as Row)['qty'], 7)

    sales.put(sale(1, 3, 10)) // enters
    assert.equal(live.size.peek(), 51)
    sales.drop(2) // leaves
    assert.equal(live.size.peek(), 50)
  })

  test('demand travels the tree: sources feed on the first look and rest after', () => {
    const asked: string[] = []
    const sales = owned(
      table<Row>({
        key: r => r['id'] as Key,
        onDemand: () => asked.push('on'),
        onIdle: () => asked.push('off'),
      }),
    )
    const live = living(filter(source('sales', ['id']), cmp('>', field('qty'), lit(0))), { sales })
    assert.deepEqual(asked, [], 'nothing feeds an unwatched relation')

    const stop = until(subscribe(live.all, () => {}))
    assert.deepEqual(asked, ['on'])
    stop() // the last look leaves: the source is told to rest
    assert.deepEqual(asked, ['on', 'off'])
  })

  test('build errors are named before anything runs', () => {
    assert.throws(
      () => checkNode(pure(source('s', ['id']), { pick: ['total'] })),
      /picks away key field 'id'/,
    )
    assert.throws(
      () => checkNode(pure(source('s', ['id']), { fields: { id: lit(1) } })),
      /recomputes key field 'id'/,
    )
    assert.throws(() => checkNode(source('s', [])), /declares no key/)
  })

  test('why descends to the source; canon dies on a closure and lives on data', () => {
    const sales = table<Row>({ key: r => r['id'] as Key })
    sales.put(sale(3, 2, 10))
    const asData = pure(filter(source('sales', ['id']), cmp('>', field('qty'), lit(0))), {
      fields: { total: math('*', field('qty'), field('price')) },
    })
    const live = living(asData, { sales })
    assert.deepEqual(live.why(3), [{ source: 'sales', key: 3 }])
    assert.equal(live.canon, '(pure {total=(.qty*.price)} (filter (.qty>0) (source sales key=id)))')

    const withClosure = living(
      filter(source('sales', ['id']), r => (r['qty'] as number) > 0),
      {
        sales,
      },
    )
    assert.equal(withClosure.canon, null, 'a closure anywhere costs the tree its canon')
  })

  const client = (id: number, tier: string): Row => ({ id, tier })
  const order = (id: number, owner: number, sum: number): Row => ({ id, client: owner, sum })

  const parity = (
    tree: ReturnType<typeof join>,
    step: (tick: number, rand: (n: number) => number) => void,
    tables: Record<string, ReturnType<typeof table<Row>>>,
  ): void => {
    const live = living(tree, tables)
    until(subscribe(live.all, () => {}))
    let seed = 41
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let tick = 0; tick < 250; tick++) {
      step(tick, rand)
      const held: Record<string, Map<Key, Row>> = {}
      for (const [name, t] of Object.entries(tables)) {
        const rows = new Map<Key, Row>()
        for (const r of t.all.peek()) rows.set(r['id'] as Key, r)
        held[name] = rows
      }
      const truth = oracle(tree, held)
      const got = live.all.peek()
      assert.equal(got.length, truth.size, `tick ${tick}`)
      for (const row of got) {
        const key = JSON.stringify([row['id'], (row['c'] as Row | null)?.['id'] ?? null])
        assert.deepEqual(row, truth.get(key), `tick ${tick} key ${key}`)
      }
    }
    for (const t of Object.values(tables)) t.dispose()
  }

  test('join parity: inner with a residual, against the oracle at every step', () => {
    const orders = feed('orders')
    const clients = feed('clients')
    const tree = join(source('orders', ['id']), source('clients', ['id']), {
      as: 'c',
      on: [{ left: 'client', right: 'id' }],
      residual: cmp('>', field('sum'), lit(10)),
    })
    parity(
      tree,
      (_tick, rand) => {
        const move = rand(4)
        if (move === 0) orders.put(order(rand(30), rand(8), rand(40)))
        else if (move === 1) orders.drop(rand(30))
        else if (move === 2) clients.put(client(rand(8), rand(2) === 0 ? 'gold' : 'plain'))
        else clients.drop(rand(8))
      },
      { orders, clients },
    )
  })

  test('join parity: keeping — an unmatched left survives with null', () => {
    const orders = feed('orders')
    const clients = feed('clients')
    const tree = join(source('orders', ['id']), source('clients', ['id']), {
      as: 'c',
      on: [{ left: 'client', right: 'id' }],
      keeping: true,
    })
    parity(
      tree,
      (_tick, rand) => {
        const move = rand(4)
        if (move === 0) orders.put(order(rand(30), rand(12), rand(40)))
        else if (move === 1) orders.drop(rand(30))
        else if (move === 2) clients.put(client(rand(6), 'plain'))
        else clients.drop(rand(6))
      },
      { orders, clients },
    )
  })

  test('join parity: a self-join counts no pair twice', () => {
    const people = feed('people')
    const tree = join(source('people', ['id']), source('people', ['id']), {
      as: 'c',
      on: [{ left: 'client', right: 'client' }],
      residual: cmp('!=', field('id'), field('c', 'id')),
    })
    parity(
      tree,
      (_tick, rand) => {
        if (rand(3) === 0) people.drop(rand(16))
        else people.put(order(rand(16), rand(4), rand(40)))
      },
      { people },
    )
  })

  test('a join edit pays its partners: a stranger row never wakes', () => {
    const orders = table<Row>({ key: r => r['id'] as Key })
    const clients = table<Row>({ key: r => r['id'] as Key })
    for (let i = 0; i < 50; i++) orders.put(order(i, i % 5, 100))
    for (let i = 0; i < 5; i++) clients.put(client(i, 'plain'))
    const live = living(
      join(source('orders', ['id']), source('clients', ['id']), {
        as: 'c',
        on: [{ left: 'client', right: 'id' }],
      }),
      { orders, clients },
    )
    const strangerKey = JSON.stringify([7, 2]) // order 7 belongs to client 2
    let strangerWakes = 0
    until(subscribe(live.all, () => {}))
    until(subscribe(live.row(strangerKey), () => strangerWakes++))

    strangerWakes = 0
    clients.put(client(3, 'gold')) // client 3 moved; client 2's pairs stand still
    assert.equal(strangerWakes, 0, 'a right edit reaches its partners and nobody else')
    assert.equal(
      (live.row(JSON.stringify([8, 3])).peek() as Row | undefined)?.['c'],
      clients.peek(3),
    )
  })

  test('why splits a composite key; a keeping phantom names only its left parent', () => {
    const orders = table<Row>({ key: r => r['id'] as Key })
    const clients = table<Row>({ key: r => r['id'] as Key })
    orders.put(order(1, 5, 20), order(2, 99, 20))
    clients.put(client(5, 'gold'))
    const live = living(
      join(source('orders', ['id']), source('clients', ['id']), {
        as: 'c',
        on: [{ left: 'client', right: 'id' }],
        keeping: true,
      }),
      { orders, clients },
    )
    until(subscribe(live.all, () => {}))
    assert.deepEqual(live.why(JSON.stringify([1, 5])), [
      { source: 'orders', key: 1 },
      { source: 'clients', key: 5 },
    ])
    assert.deepEqual(live.why(JSON.stringify([2, null])), [{ source: 'orders', key: 2 }])
  })

  test('agg parity: groups move, folds follow, against the oracle at every step', () => {
    const orders = feed('orders')
    const tree = agg(source('orders', ['id']), {
      by: ['client'],
      folds: {
        n: { fold: 'count' },
        total: { fold: 'sum', of: field('sum') },
        top: { fold: 'max', of: field('sum') },
        ids: { fold: 'collect', of: field('id') },
      },
    })
    const live = living(tree, { orders })
    until(subscribe(live.all, () => {}))
    let seed = 91
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let tick = 0; tick < 250; tick++) {
      if (rand(3) === 0) orders.drop(rand(24))
      else orders.put(order(rand(24), rand(5), rand(50)))
      const rows = new Map<Key, Row>()
      for (const r of orders.all.peek()) rows.set(r['id'] as Key, r)
      const truth = oracle(tree, { orders: rows })
      const got = live.all.peek()
      assert.equal(got.length, truth.size, `tick ${tick}`)
      for (const row of got) assert.deepEqual(row, truth.get(row['client'] as Key), `tick ${tick}`)
    }
  })

  test('having: a filter over an agg eats the fold deltas like any other change', () => {
    const orders = feed('orders')
    const tree = filter(
      agg(source('orders', ['id']), {
        by: ['client'],
        folds: { total: { fold: 'sum', of: field('sum') } },
      }),
      cmp('>', field('total'), lit(100)),
    )
    const live = living(tree, { orders })
    until(subscribe(live.all, () => {}))
    orders.put(order(1, 7, 60), order(2, 7, 50), order(3, 8, 30))
    assert.equal(live.size.peek(), 1, 'client 7 crossed the bar, client 8 did not')
    orders.drop(2)
    assert.equal(live.size.peek(), 0, 'the group fell back under and left the view')
    orders.put(order(4, 8, 90))
    assert.equal((live.row(8).peek() as Row)['total'], 120)
  })

  test('an agg edit pays its group: a stranger group never wakes', () => {
    const orders = table<Row>({ key: r => r['id'] as Key })
    for (let i = 0; i < 60; i++) orders.put(order(i, i % 6, 10))
    const live = living(
      agg(source('orders', ['id']), {
        by: ['client'],
        folds: { total: { fold: 'sum', of: field('sum') } },
      }),
      { orders },
    )
    until(subscribe(live.all, () => {}))
    let strangerWakes = 0
    until(subscribe(live.row(2), () => strangerWakes++))
    strangerWakes = 0
    orders.put(order(6, 0, 999)) // group 0 moved; group 2 stands still
    assert.equal(strangerWakes, 0)
    assert.equal((live.row(0).peek() as Row)['total'], 999 + 9 * 10)
  })

  test('fold carriers are named at the same door: an inverse runs, the rest oracle', async () => {
    const heard: Array<{ name: string; carrier: string }> = []
    until(
      onNotice(what => {
        if (what.kind === 'fold-plan')
          heard.push({ name: what.where, carrier: String(what.detail?.['carrier']) })
      }),
    )
    const orders = owned(table<Row>({ key: r => r['id'] as Key }))
    living(
      agg(source('orders', ['id']), {
        by: ['client'],
        folds: { total: { fold: 'sum', of: field('sum') }, top: { fold: 'max', of: field('sum') } },
      }),
      { orders },
    )
    assert.deepEqual(
      heard.filter(h => h.name.startsWith('agg.')),
      [
        { name: 'agg.total', carrier: 'running' },
        { name: 'agg.top', carrier: 'oracle' },
      ],
    )
  })

  test('why for a group names its members, found when asked', () => {
    const orders = table<Row>({ key: r => r['id'] as Key })
    orders.put(order(1, 7, 10), order(2, 7, 20), order(3, 8, 30))
    const live = living(
      agg(source('orders', ['id']), {
        by: ['client'],
        folds: { n: { fold: 'count' } },
      }),
      { orders },
    )
    until(subscribe(live.all, () => {}))
    assert.deepEqual(live.why(7), [
      { source: 'orders', key: 1 },
      { source: 'orders', key: 2 },
    ])
  })

  test('the whole-table fold is one row that exists even over nothing', () => {
    const orders = owned(table<Row>({ key: r => r['id'] as Key }))
    const live = living(
      agg(source('orders', ['id']), {
        by: [],
        folds: { n: { fold: 'count' }, total: { fold: 'sum', of: field('sum') } },
      }),
      { orders },
    )
    until(subscribe(live.all, () => {}))
    assert.equal(live.size.peek(), 1)
    assert.deepEqual(live.all.peek()[0], { n: 0, total: 0 })
    orders.put(order(1, 5, 40), order(2, 6, 2))
    assert.deepEqual(live.all.peek()[0], { n: 2, total: 42 })
    orders.drop(1)
    orders.drop(2)
    assert.deepEqual(live.all.peek()[0], { n: 0, total: 0 }, 'emptied, not gone')
  })

  test('union parity: two feeds, one table, against the oracle at every step', () => {
    const fresh = feed('fresh')
    const stale = feed('stale')
    const tree = union(source('fresh', ['id']), source('stale', ['id']))
    const live = living(tree, { fresh, stale })
    until(subscribe(live.all, () => {}))
    let seed = 17
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let tick = 0; tick < 250; tick++) {
      const move = rand(4)
      // Disjoint by construction: fresh holds even ids, stale holds odd.
      if (move === 0) fresh.put(order(rand(15) * 2, rand(5), rand(50)))
      else if (move === 1) fresh.drop(rand(15) * 2)
      else if (move === 2) stale.put(order(rand(15) * 2 + 1, rand(5), rand(50)))
      else stale.drop(rand(15) * 2 + 1)
      const held: Record<string, Map<Key, Row>> = {}
      for (const [name, t] of [
        ['fresh', fresh],
        ['stale', stale],
      ] as const) {
        const rows = new Map<Key, Row>()
        for (const r of t.all.peek()) rows.set(r['id'] as Key, r)
        held[name] = rows
      }
      const truth = oracle(tree, held)
      const got = live.all.peek()
      assert.equal(got.length, truth.size, `tick ${tick}`)
      for (const row of got) assert.deepEqual(row, truth.get(row['id'] as Key), `tick ${tick}`)
    }
    fresh.dispose()
    stale.dispose()
  })

  test('union: a key on both sides is a named error, and mismatched keying never builds', () => {
    const a = table<Row>({ key: r => r['id'] as Key })
    const b = table<Row>({ key: r => r['id'] as Key })
    a.put(order(5, 1, 10))
    const live = living(union(source('a', ['id']), source('b', ['id'])), { a, b })
    until(subscribe(live.all, () => {}))
    assert.throws(() => b.put(order(5, 2, 20)), /union key collision on 5/)
    a.dispose()
    b.dispose()
    assert.throws(
      () => checkNode(union(source('a', ['id']), source('b', ['other']))),
      /union sides key differently/,
    )
  })

  test('expand parity: nested tables unfold and follow, against the oracle', () => {
    const docs = feed('docs')
    const tree = expand(source('docs', ['id']), { field: 'links', as: 'link', key: ['to'] })
    const live = living(tree, { docs })
    until(subscribe(live.all, () => {}))
    let seed = 29
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const doc = (id: number): Row => {
      const links: Row[] = []
      const n = rand(4)
      for (let i = 0; i < n; i++) {
        const to = rand(9)
        if (!links.some(l => l['to'] === to)) links.push({ to, weight: rand(5) })
      }
      return { id, links }
    }
    for (let tick = 0; tick < 250; tick++) {
      if (rand(3) === 0) docs.drop(rand(12))
      else docs.put(doc(rand(12)))
      const rows = new Map<Key, Row>()
      for (const r of docs.all.peek()) rows.set(r['id'] as Key, r)
      const truth = oracle(tree, { docs: rows })
      const got = live.all.peek()
      assert.equal(got.length, truth.size, `tick ${tick}`)
      for (const row of got) {
        const key = JSON.stringify([row['id'], (row['link'] as Row)['to']])
        assert.deepEqual(row, truth.get(key), `tick ${tick}`)
      }
    }
    docs.dispose()
  })

  test('expand consumes the table field and why names the parent alone', () => {
    const docs = table<Row>({ key: r => r['id'] as Key })
    docs.put({ id: 1, title: 'a', links: [{ to: 9, weight: 2 }] })
    const live = living(
      expand(source('docs', ['id']), { field: 'links', as: 'link', key: ['to'] }),
      {
        docs,
      },
    )
    until(subscribe(live.all, () => {}))
    assert.deepEqual(live.all.peek()[0], { id: 1, title: 'a', link: { to: 9, weight: 2 } })
    assert.deepEqual(live.why(JSON.stringify([1, 9])), [{ source: 'docs', key: 1 }])
    docs.dispose()
  })

  test('a named carry survives the table outgrowing the stored-carry limit', () => {
    // The builder's type promises the named field on every row. The planner
    // used to trade it away past the limit — correct on test-sized data,
    // `undefined` in production the day the table grew. The plan may pick the
    // carrier; the field itself is not its to take, and past the limit the
    // price is a warning on the notice channel, not a silent lie.
    const warned: string[] = []
    until(
      onNotice(what => {
        if (what.kind === 'scan-plan' && what.level === 'warn') warned.push(what.where)
      }),
    )
    const rows = table<Row>({ key: r => r['id'] as Key })
    const many: Row[] = []
    for (let i = 0; i < 5000; i++) many.push({ id: i, rank: i, height: 10 })
    rows.put(many)
    const live = living(
      scan(source('rows', ['id']), {
        order: [{ field: 'rank' }],
        step: field('height'),
        as: 'offset',
      }),
      { rows },
    )
    until(subscribe(live.all, () => {}))
    until(() => live.dispose())

    assert.equal((live.row(0).peek() as Row)['offset'], 0)
    assert.equal((live.row(4999).peek() as Row)['offset'], 4999 * 10, 'the promised field is real')
    rows.put({ id: 2500, rank: 2500, height: 20 })
    assert.equal((live.row(4999).peek() as Row)['offset'], 4999 * 10 + 10, 'and stays real on edit')
    assert.equal(warned.includes('scan.offset'), true, 'the price was said aloud')
  })

  test('scan parity: a running total in order, against the oracle at every step', () => {
    const rows = feed('rows')
    const tree = scan(source('rows', ['id']), {
      order: [{ field: 'rank' }],
      step: field('height'),
      as: 'offset',
      through: 'end',
    })
    const live = living(tree, { rows })
    until(subscribe(live.all, () => {}))
    let seed = 53
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let tick = 0; tick < 250; tick++) {
      if (rand(4) === 0) rows.drop(rand(20))
      else rows.put({ id: rand(20), rank: rand(100), height: 20 + rand(80) })
      const held = new Map<Key, Row>()
      for (const r of rows.all.peek()) held.set(r['id'] as Key, r)
      const truth = oracle(tree, { rows: held })
      const got = live.all.peek()
      assert.equal(got.length, truth.size, `tick ${tick}`)
      for (const row of got) assert.deepEqual(row, truth.get(row['id'] as Key), `tick ${tick}`)
    }
    rows.dispose()
  })

  test('a scan pays its tail, and the carrier is named at the same door', async () => {
    const heard: string[] = []
    until(
      onNotice(what => {
        if (what.kind === 'scan-plan')
          heard.push(`${what.where}:${String(what.detail?.['carrier'])}`)
      }),
    )

    const rows = table<Row>({ key: r => r['id'] as Key })
    for (let i = 0; i < 400; i++) rows.put({ id: i, rank: i, height: 50 })
    const live = living(
      scan(source('rows', ['id']), {
        order: [{ field: 'rank' }],
        step: field('height'),
        as: 'offset',
      }),
      { rows },
    )
    until(subscribe(live.all, () => {}))
    assert.deepEqual(heard, ['scan.offset:offsets'], 'a numeric carry over 400 rows takes the line')

    assert.equal((live.row(10).peek() as Row)['offset'], 500)
    let aheadWakes = 0
    until(subscribe(live.row(5), () => aheadWakes++))
    aheadWakes = 0
    rows.put({ id: 300, rank: 300, height: 90 }) // a row far below moves
    assert.equal(aheadWakes, 0, 'a scan owes its tail, never its head')
    assert.equal((live.row(301).peek() as Row)['offset'], 300 * 50 + 90)
    rows.dispose()
  })

  describe('a row with nothing in its key field', () => {
    test('joins nobody — and least of all the other rows that also have nothing', () => {
      const orders = feed('orders')
      const clients = feed('clients')
      const live = living(
        join(source('orders', ['id']), source('clients', ['id']), {
          as: 'c',
          on: [{ left: 'client', right: 'code' }],
        }),
        { orders, clients },
      )
      until(subscribe(live.all, () => {}))

      orders.put(
        { id: 1, client: null } as unknown as Row,
        { id: 2, client: null } as unknown as Row,
      )
      clients.put({ id: 10, code: null } as unknown as Row)
      assert.equal(live.size.peek(), 0, 'no pairs at all: an absence is not a value')

      // And the moment a real key appears, the row joins like any other.
      orders.put({ id: 1, client: 7 } as unknown as Row)
      clients.put({ id: 11, code: 7 } as unknown as Row)
      assert.equal(live.size.peek(), 1)
    })

    test('stands alone in a keeping join, rather than pairing with its like', () => {
      const orders = feed('orders')
      const clients = feed('clients')
      const live = living(
        join(source('orders', ['id']), source('clients', ['id']), {
          as: 'c',
          on: [{ left: 'client', right: 'code' }],
          keeping: true,
        }),
        { orders, clients },
      )
      until(subscribe(live.all, () => {}))

      orders.put(
        { id: 1, client: null } as unknown as Row,
        { id: 2, client: null } as unknown as Row,
      )
      clients.put({ id: 10, code: null } as unknown as Row)
      assert.equal(live.size.peek(), 2, 'both stand alone')
      assert.deepEqual(
        live.all.peek().map(r => r['c']),
        [null, null],
      )
    })
  })

  test('a join on something too common says so, once', () => {
    const heard: Array<{ node: string; rows: number }> = []
    until(
      onNotice(what => {
        if (what.kind === 'crowded-join')
          heard.push({ node: what.where, rows: Number(what.detail?.['rows']) })
      }),
    )

    const orders = feed('orders')
    const shops = feed('shops')
    const live = living(
      join(source('orders', ['id']), source('shops', ['id']), {
        as: 's',
        on: [{ left: 'status', right: 'status' }],
      }),
      { orders, shops },
    )
    until(subscribe(live.all, () => {}))

    // Every order has the same status: one shop arriving would make as many
    // rows as there are orders.
    const many = Array.from(
      { length: CROWDED_KEY + 5 },
      (_, i) => ({ id: i, status: 'open' }) as unknown as Row,
    )
    orders.put(many)

    assert.equal(heard.length, 1, 'said once, not per row')
    assert.match(heard[0]?.node ?? '', /status=status/)
    assert.ok((heard[0]?.rows ?? 0) >= CROWDED_KEY)
  })

  test('an ordinary join says nothing', () => {
    const heard: unknown[] = []
    until(
      onNotice(what => {
        if (what.kind === 'crowded-join') heard.push(what)
      }),
    )

    const orders = feed('orders')
    const clients = feed('clients')
    const live = living(
      join(source('orders', ['id']), source('clients', ['id']), {
        as: 'c',
        on: [{ left: 'client', right: 'id' }],
      }),
      { orders, clients },
    )
    until(subscribe(live.all, () => {}))

    orders.put(Array.from({ length: 500 }, (_, i) => ({ id: i, client: i }) as unknown as Row))
    assert.deepEqual(heard, [])
  })

  describe('why a row is here', () => {
    test('a joined row names both sources it came from', () => {
      const orders = feed('orders')
      const clients = feed('clients')
      const tree = join(source('orders', ['id']), source('clients', ['id']), {
        as: 'c',
        on: [{ left: 'client', right: 'id' }],
      })
      const live = living(tree, { orders, clients })
      until(subscribe(live.all, () => {}))

      orders.put({ id: 1, client: 7 } as unknown as Row)
      clients.put({ id: 7, tier: 'gold' } as unknown as Row)

      const shown = live.all.peek()[0]
      assert.ok(shown !== undefined)
      // The key of a row of this relation, taken the way the relation takes it.
      const from = live.why(keyOfRow(tree, shown))
      assert.deepEqual(
        from.map(one => one.source).toSorted(),
        ['clients', 'orders'],
        'both halves are named, and the descent happens when asked',
      )
    })

    test('a grouped row names every row that went into it', () => {
      const sales = feed('sales')
      const live = living(
        agg(source('sales', ['id']), { by: ['shop'], folds: { n: { fold: 'count' } } }),
        { sales },
      )
      until(subscribe(live.all, () => {}))

      sales.put(
        { id: 1, shop: 'a' } as unknown as Row,
        { id: 2, shop: 'a' } as unknown as Row,
        { id: 3, shop: 'b' } as unknown as Row,
      )

      const shelf = live.all.peek().find(r => r['shop'] === 'a')
      assert.ok(shelf !== undefined)
      const from = live.why('a')
      assert.deepEqual(
        from.map(one => one.key).toSorted(),
        [1, 2],
        'the two sales of that shop, not the third',
      )
    })
  })

  describe('what a tree says about itself', () => {
    test('key paths follow the tree, not the tables under it', () => {
      const orders = source('orders', ['id'])
      const clients = source('clients', ['id'])

      assert.deepEqual(keyPaths(orders), [['id']])

      const joined = join(orders, clients, { as: 'c', on: [{ left: 'client', right: 'id' }] })
      assert.deepEqual(
        joined ? keyPaths(joined) : [],
        [['id'], ['c', 'id']],
        'both halves, and where each lives',
      )

      const grouped = agg(orders, { by: ['shop'], folds: { n: { fold: 'count' } } })
      assert.deepEqual(keyPaths(grouped), [['shop']], 'a group is keyed by what it grouped on')
    })

    test('the parameters of a tree are found wherever they stand', () => {
      const plain = filter(source('orders', ['id']), cmp('>', field('sum'), lit(10)))
      assert.deepEqual([...paramsOfNode(plain)], [], 'a tree of constants asks for nothing')

      const asked = filter(source('orders', ['id']), cmp('>', field('sum'), param('floor')))
      assert.deepEqual([...paramsOfNode(asked)], ['floor'])

      const deeper = agg(asked, { by: ['shop'], folds: { n: { fold: 'count' } } })
      assert.deepEqual([...paramsOfNode(deeper)], ['floor'], 'found under a group too')
    })

    test('why, asked of the tree itself rather than through a relation', () => {
      const tree = source('orders', ['id'])
      const rows = new Map([[1, { id: 1 } as Row]])
      assert.deepEqual(whyRow(tree, 1, { orders: rows }), [{ source: 'orders', key: 1 }])
    })

    test('some: the part gave something rather than nothing', () => {
      // Not "there exists a row satisfying it", which the name suggests to
      // everyone who reads it first: the part is evaluated once and the answer
      // is whether it came back with anything at all. Worth knowing before
      // reaching for it — and worth a better name one day.
      const present = some(field('note'))
      assert.equal(evalExpr(present, { note: 'anything' } as unknown as Row), true)
      assert.equal(evalExpr(present, { note: null } as unknown as Row), false)
      assert.equal(evalExpr(present, {} as unknown as Row), false, 'absent counts as nothing')
      assert.equal(
        evalExpr(present, { note: '' } as unknown as Row),
        true,
        'empty is still something',
      )
    })
  })
})
