import assert from 'node:assert/strict'
import { test } from 'node:test'
import { subscribe } from '#weft'
import { table } from '#weft'
import type { Key } from '#weft'
import { and, canonExpr, cmp, evalExpr, field, lit, math } from '#weft/rel/expr.ts'
import type { Row } from '#weft/rel/expr.ts'
import { checkNode, filter, join, pure, recount, source } from '#weft/rel/node.ts'
import { relate } from '#weft/rel/live.ts'

const sale = (id: number, qty: number, price: number): Row => ({ id, qty, price })

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

test('oracle parity: the live chain answers like a recount, at every step', () => {
  const sales = table<Row>({ key: r => r['id'] as Key, name: 'sales' })
  const tree = pure(filter(source('sales', ['id']), cmp('>', field('qty'), lit(0))), {
    fields: { total: math('*', field('qty'), field('price')) },
    pick: ['id', 'total'],
  })
  const live = relate(tree, { sales })
  const stop = subscribe(live.all, () => {})

  const check = (): void => {
    const rows = new Map<Key, Row>()
    for (const r of sales.all.peek()) rows.set(r['id'] as Key, r)
    const truth = recount(tree, { sales: rows })
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
  stop()
  live.dispose()
  sales.dispose()
})

test('an edit pays as the edit: dead rows are silent, one move is one wake', () => {
  const sales = table<Row>({ key: r => r['id'] as Key, name: 'sales' })
  for (let i = 0; i < 100; i++) sales.put(sale(i, i % 2 === 0 ? 5 : -1, 10))
  const live = relate(filter(source('sales', ['id']), cmp('>', field('qty'), lit(0))), { sales })

  let wakes = 0
  const stop = subscribe(live.all, () => wakes++)

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
  stop()
  live.dispose()
  sales.dispose()
})

test('demand travels the tree: sources feed on the first look and rest after', () => {
  const asked: string[] = []
  const sales = table<Row>({
    key: r => r['id'] as Key,
    onDemand: () => asked.push('on'),
    onIdle: () => asked.push('off'),
  })
  const live = relate(filter(source('sales', ['id']), cmp('>', field('qty'), lit(0))), { sales })
  assert.deepEqual(asked, [], 'nothing feeds an unwatched relation')

  const stop = subscribe(live.all, () => {})
  assert.deepEqual(asked, ['on'])
  stop()
  assert.deepEqual(asked, ['on', 'off'])
  live.dispose()
  sales.dispose()
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
  const live = relate(asData, { sales })
  assert.deepEqual(live.why(3), [{ source: 'sales', key: 3 }])
  assert.equal(live.canon, '(pure {total=(.qty*.price)} (filter (.qty>0) (source sales key=id)))')

  const withClosure = relate(
    filter(source('sales', ['id']), r => (r['qty'] as number) > 0),
    {
      sales,
    },
  )
  assert.equal(withClosure.canon, null, 'a closure anywhere costs the tree its canon')
  live.dispose()
  withClosure.dispose()
  sales.dispose()
})

const client = (id: number, tier: string): Row => ({ id, tier })
const order = (id: number, owner: number, sum: number): Row => ({ id, client: owner, sum })

const parity = (
  tree: ReturnType<typeof join>,
  step: (tick: number, rand: (n: number) => number) => void,
  tables: Record<string, ReturnType<typeof table<Row>>>,
): void => {
  const live = relate(tree, tables)
  const stop = subscribe(live.all, () => {})
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
    const truth = recount(tree, held)
    const got = live.all.peek()
    assert.equal(got.length, truth.size, `tick ${tick}`)
    for (const row of got) {
      const key = JSON.stringify([row['id'], (row['c'] as Row | null)?.['id'] ?? null])
      assert.deepEqual(row, truth.get(key), `tick ${tick} key ${key}`)
    }
  }
  stop()
  live.dispose()
  for (const t of Object.values(tables)) t.dispose()
}

test('join parity: inner with a residual, against the oracle at every step', () => {
  const orders = table<Row>({ key: r => r['id'] as Key, name: 'orders' })
  const clients = table<Row>({ key: r => r['id'] as Key, name: 'clients' })
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
  const orders = table<Row>({ key: r => r['id'] as Key, name: 'orders' })
  const clients = table<Row>({ key: r => r['id'] as Key, name: 'clients' })
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
  const people = table<Row>({ key: r => r['id'] as Key, name: 'people' })
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
  const live = relate(
    join(source('orders', ['id']), source('clients', ['id']), {
      as: 'c',
      on: [{ left: 'client', right: 'id' }],
    }),
    { orders, clients },
  )
  const strangerKey = JSON.stringify([7, 2]) // order 7 belongs to client 2
  let strangerWakes = 0
  const stopAll = subscribe(live.all, () => {})
  const stopOne = subscribe(live.row(strangerKey), () => strangerWakes++)

  strangerWakes = 0
  clients.put(client(3, 'gold')) // client 3 moved; client 2's pairs stand still
  assert.equal(strangerWakes, 0, 'a right edit reaches its partners and nobody else')
  assert.equal((live.row(JSON.stringify([8, 3])).peek() as Row | undefined)?.['c'], clients.peek(3))

  stopOne()
  stopAll()
  live.dispose()
  orders.dispose()
  clients.dispose()
})

test('why splits a composite key; a keeping phantom names only its left parent', () => {
  const orders = table<Row>({ key: r => r['id'] as Key })
  const clients = table<Row>({ key: r => r['id'] as Key })
  orders.put(order(1, 5, 20), order(2, 99, 20))
  clients.put(client(5, 'gold'))
  const live = relate(
    join(source('orders', ['id']), source('clients', ['id']), {
      as: 'c',
      on: [{ left: 'client', right: 'id' }],
      keeping: true,
    }),
    { orders, clients },
  )
  const stop = subscribe(live.all, () => {})
  assert.deepEqual(live.why(JSON.stringify([1, 5])), [
    { source: 'orders', key: 1 },
    { source: 'clients', key: 5 },
  ])
  assert.deepEqual(live.why(JSON.stringify([2, null])), [{ source: 'orders', key: 2 }])
  stop()
  live.dispose()
  orders.dispose()
  clients.dispose()
})
