// Beside the code because it reaches for `RowOf` — an internal way of asking
// what row type a chain arrived at, which the library does not offer.
// What the chain's types promise, proven by compiling.
//
// This one lives beside the code rather than in `test/`, because it reaches
// for `RowOf` — an internal way of asking what row type a chain has arrived
// at, which the library does not offer the world. A test that needs the inside
// of a module belongs next to it; a test that needs only the public surface
// belongs in `test/`.
//
// Everything here is proven at compile time; the bodies run as no-ops.

import { describe, test } from 'node:test'
import { from } from '../src/builder.ts'
import type { RowOf } from '../src/builder.ts'

interface Order {
  id: number
  client: number
  sum: number
}

interface Client {
  id: number
  tier: string
}

type Flat<T> = { [K in keyof T]: T[K] }
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const proven = <T extends true>(): T => true as T

describe('the types of the query builder', () => {
  test('a join merges the rows; keeping one admits null on the other side', () => {
    const orders = from<Order>('orders', 'id')
    const clients = from<Client>('clients', 'id')

    const matched = orders.join(clients, { as: 'c', on: ['client', 'id'] })
    proven<Same<Flat<RowOf<typeof matched>>, Flat<Order & { c: Client }>>>()

    const kept = orders.join(clients, { as: 'c', on: ['client', 'id'], keeping: true })
    proven<Same<Flat<RowOf<typeof kept>>, Flat<Order & { c: Client | null }>>>()
  })

  test('a group answers with its by-fields beside every fold', () => {
    const shelves = from<Order>('orders', 'id').groupBy('client', g => ({
      n: g.count(),
      total: g.sum('sum'),
      top: g.max('sum'),
      ids: g.collectOf('id'),
    }))
    proven<
      Same<
        Flat<RowOf<typeof shelves>>,
        { client: number; n: number; total: number; top: number | null; ids: number[] }
      >
    >()
  })

  test('picking narrows the row to what was picked', () => {
    const picked = from<Order>('orders', 'id').pick('id', 'sum')
    proven<Same<Flat<RowOf<typeof picked>>, Flat<Pick<Order, 'id' | 'sum'>>>>()
  })

  test('expanding replaces the list field with one row under its alias', () => {
    interface Doc {
      id: number
      title: string
      links: Array<{ to: number; weight: number }>
    }
    const opened = from<Doc>('docs', 'id').expand('links', { as: 'link', key: ['to'] })
    proven<
      Same<
        Flat<RowOf<typeof opened>>,
        Flat<Omit<Doc, 'links'> & { link: { to: number; weight: number } }>
      >
    >()
  })

  test('what must not compile, does not', () => {
    const orders = from<Order>('orders', 'id')
    const clients = from<Client>('clients', 'id')

    // @ts-expect-error — no such field on Order
    orders.where('summ', '>', 5)
    // @ts-expect-error — order comparison on a string field
    clients.where('tier', '>', 'gold')
    // @ts-expect-error — a sum wants a field holding numbers
    clients.groupBy('id', g => ({ s: g.sum('tier') }))
    // @ts-expect-error — the two sides are matched on fields of different types
    orders.join(clients, { as: 'c', on: ['sum', 'tier'] })
    // @ts-expect-error — the row already has a field by that name
    orders.with('sum', null as never)
    // @ts-expect-error — a scan steps by a number
    orders.scan({ by: 'id', step: 'client' as never as 'nope' })
  })
})

test('a closure in the builder knows the row it is given', () => {
  // Before this the builder took `RowFn` — a function over a nameless row — so
  // a correct closure had to be annotated by hand and a wrong one complained
  // about `Row`, not about the field. The row type is a promise to whoever
  // writes the closure; the tree below still holds the nameless form, because
  // a tree that travels cannot carry a caller's types with it.
  interface Sale {
    readonly id: number
    readonly sum: number
  }
  const orders = from<Sale>('sales', ['id'])

  const doubled = orders.with('twice', row => row.sum * 2).filter(row => row.sum > 10)

  // @ts-expect-error — the row has no such field, and that is what it says
  const wrong = orders.with('twice', row => row.nope * 2)

  void doubled
  void wrong
})
