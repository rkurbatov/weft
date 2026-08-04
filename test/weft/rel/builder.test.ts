import assert from 'node:assert/strict'
import { test } from 'node:test'
import { subscribe, table } from '#weft'
import type { Key } from '#weft'
import {
  agg,
  canonNode,
  cmp,
  field,
  filter,
  from,
  join,
  lit,
  param as paramDoor,
  relate as relateDoor,
  source,
} from '#weft/rel'
import type { Row } from '#weft/rel'

interface Order {
  id: number
  client: number
  sum: number
}
interface Client {
  id: number
  tier: string
}

// Type proofs: they run as a no-op, they prove at compile time.
type Flat<T> = { [K in keyof T]: T[K] }
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const proven = <T extends true>(): T => true as T

test('the chain carries the row type: joins merge, keeping admits null, folds answer', () => {
  const orders = from<Order>('orders', 'id')
  const clients = from<Client>('clients', 'id')

  const matched = orders.join(clients, { as: 'c', on: ['client', 'id'] })
  type MatchedRow = ReturnType<
    (typeof matched)['live']
  >['all']['peek'] extends () => readonly (infer T)[]
    ? T
    : never
  proven<Same<Flat<MatchedRow>, Flat<Order & { c: Client }>>>()

  const kept = orders.join(clients, { as: 'c', on: ['client', 'id'], keeping: true })
  type KeptRow = ReturnType<(typeof kept)['live']>['all']['peek'] extends () => readonly (infer T)[]
    ? T
    : never
  proven<Same<Flat<KeptRow>, Flat<Order & { c: Client | null }>>>()

  const shelves = orders.groupBy('client', g => ({
    n: g.count(),
    total: g.sum('sum'),
    top: g.max('sum'),
    ids: g.collectOf('id'),
  }))
  type ShelfRow = ReturnType<
    (typeof shelves)['live']
  >['all']['peek'] extends () => readonly (infer T)[]
    ? T
    : never
  proven<
    Same<
      Flat<ShelfRow>,
      { client: number; n: number; total: number; top: number | null; ids: number[] }
    >
  >()

  const picked = orders.pick('id', 'sum')
  type PickedRow = ReturnType<
    (typeof picked)['live']
  >['all']['peek'] extends () => readonly (infer T)[]
    ? T
    : never
  proven<Same<Flat<PickedRow>, Flat<Pick<Order, 'id' | 'sum'>>>>()

  // Typos and wrong operators do not compile:
  // @ts-expect-error — no such field on Order
  orders.where('summ', '>', 5)
  // @ts-expect-error — order comparison on a string field
  clients.where('tier', '>', 'gold')
  // @ts-expect-error — sum wants a numeric field
  clients.groupBy('id', g => ({ s: g.sum('tier') }))
})

test('the chain builds the very tree a hand would: canon for canon', () => {
  const chained = from<Order>('orders', 'id')
    .where('sum', '>', 10)
    .groupBy('client', g => ({ n: g.count() }))
    .tree()
  const byHand = agg(filter(source('orders', ['id']), cmp('>', field('sum'), lit(10))), {
    by: ['client'],
    folds: { n: { fold: 'count' } },
  })
  assert.equal(canonNode(chained), canonNode(byHand))
  assert.equal(
    canonNode(chained),
    '(agg by=client {n=(count)} (filter (.sum>10) (source orders key=id)))',
  )

  const joined = from<Order>('orders', 'id')
    .join(from<Client>('clients', 'id'), { as: 'c', on: ['client', 'id'], keeping: true })
    .tree()
  const joinedByHand = join(source('orders', ['id']), source('clients', ['id']), {
    as: 'c',
    on: [{ left: 'client', right: 'id' }],
    keeping: true,
  })
  assert.equal(canonNode(joined), canonNode(joinedByHand))
})

test('the chain runs: typed rows out of a live end-to-end', () => {
  const orders = table<Row>({ key: r => r['id'] as Key, name: 'orders' })
  const clients = table<Row>({ key: r => r['id'] as Key, name: 'clients' })
  orders.put(
    { id: 1, client: 7, sum: 20 },
    { id: 2, client: 7, sum: 5 },
    { id: 3, client: 8, sum: 40 },
  )
  clients.put({ id: 7, tier: 'gold' })

  const live = from<Order>('orders', 'id')
    .where('sum', '>', 10)
    .join(from<Client>('clients', 'id'), { as: 'c', on: ['client', 'id'], keeping: true })
    .live({ orders, clients })
  const stop = subscribe(live.all, () => {})

  const rows = [...live.all.peek()].toSorted((a, b) => a.id - b.id)
  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.c?.tier, 'gold')
  assert.equal(rows[1]?.c, null, 'keeping: the unmatched client is an honest null')

  orders.put({ id: 2, client: 8, sum: 15 }) // crosses the bar into the view
  assert.equal(live.all.peek().length, 3)

  stop()
  live.dispose()
  orders.dispose()
  clients.dispose()
})

test('expand and union chain with their types along', () => {
  interface Doc {
    id: number
    title: string
    links: Array<{ to: number; weight: number }>
  }
  const docs = table<Row>({ key: r => r['id'] as Key, name: 'docs' })
  docs.put({ id: 1, title: 'a', links: [{ to: 9, weight: 2 }] })

  const opened = from<Doc>('docs', 'id').expand('links', { as: 'link', key: ['to'] })
  type OpenedRow = ReturnType<
    (typeof opened)['live']
  >['all']['peek'] extends () => readonly (infer T)[]
    ? T
    : never
  proven<
    Same<Flat<OpenedRow>, Flat<Omit<Doc, 'links'> & { link: { to: number; weight: number } }>>
  >()

  const live = opened.live({ docs })
  const stop = subscribe(live.all, () => {})
  assert.deepEqual(live.all.peek()[0], { id: 1, title: 'a', link: { to: 9, weight: 2 } })
  stop()
  live.dispose()
  docs.dispose()

  const fresh = from<Order>('fresh', 'id')
  const stale = from<Order>('stale', 'id')
  assert.equal(
    canonNode(fresh.union(stale).tree()),
    '(union (source fresh key=id) (source stale key=id))',
  )
})

test('a live value in where: typing re-filters, watchers hear only the difference', async () => {
  const { input } = await import('#weft')
  const games = table<Row>({ key: r => r['id'] as Key, name: 'games' })
  games.put(
    { id: 1, title: 'north derby', sum: 1 },
    { id: 2, title: 'south open', sum: 2 },
    { id: 3, title: 'northern lights', sum: 3 },
  )
  const search = input('', { name: 'search' })
  const chain = from<{ id: number; title: string; sum: number }>('games', 'id').where(
    'title',
    'has',
    search,
  )
  assert.equal(canonNode(chain.tree()), '(filter (.title has ?p1) (source games key=id))')

  const live = chain.live({ games })
  let wakes = 0
  const stop = subscribe(live.all, () => wakes++)
  assert.equal(live.all.peek().length, 3, 'empty search passes everything')

  wakes = 0
  search.set('north')
  assert.equal(live.all.peek().length, 2)
  assert.equal(wakes, 1, 'one retune, one wake')

  wakes = 0
  search.set('north') // the same value again — the graph gates it before us
  assert.equal(wakes, 0)

  search.set('sou')
  assert.equal(
    live.all
      .peek()
      .map(r => r['id'])
      .join(','),
    '2',
  )

  // Parity with the substituted oracle at the current value.
  const rows = new Map<Key, Row>()
  for (const r of games.all.peek()) rows.set(r['id'] as Key, r)
  const { substituteNode, recount: recountDoor } = await import('#weft/rel')
  const truth = recountDoor(substituteNode(chain.tree(), new Map([['p1', 'sou']])), { games: rows })
  assert.equal(live.all.peek().length, truth.size)

  stop()
  live.dispose()
  games.dispose()
})

test('a hole without a value is a named error', () => {
  const games = table<Row>({ key: r => r['id'] as Key })
  assert.throws(
    () =>
      relateDoor(filter(source('games', ['id']), cmp('==', field('title'), paramDoor('needle'))), {
        games,
      }),
    /parameter \?needle is not provided/,
  )
  games.dispose()
})
