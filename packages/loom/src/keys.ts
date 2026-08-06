// Which fields make a row's key, learnt rather than told twice.
//
// A feed states its key as a function; the relational tree needs field names,
// because a tree is data and a closure is not. So the function is run once
// over a row that records what it is asked for.

import type { Key } from '#weft'
import type { Feed } from './feed.ts'

/**
 * Which fields make a row's key.
 *
 * A feed states its key as a function — `key: g => g.id` — and the relational
 * tree needs the field names, because a tree is data and a closure is not. So
 * the function is run once over a row that records what it is asked for: what
 * it reads is what the key is made of. A composite key works the same way,
 * since both reads are seen.
 *
 * If the function reads nothing recognisable — a key computed from the air —
 * the fields are stated by hand with `keyedBy`, and if neither works the tree
 * refuses to be built rather than guessing.
 */
export const keyFields = new WeakMap<object, readonly string[]>()

export function keyedBy<R>(feed: Feed<R>, ...fields: Array<keyof R & string>): Feed<R> {
  keyFields.set(feed as unknown as object, fields)
  return feed
}

export function fieldsRead(keyOf: (row: never) => Key): readonly string[] {
  const seen: string[] = []
  const spy = new Proxy(
    {},
    {
      get(_target, name) {
        if (
          typeof name === 'string' &&
          name !== 'toString' &&
          name !== Symbol.toPrimitive.toString()
        )
          seen.push(name)
        // A string that also survives arithmetic and template literals.
        return ''
      },
      has: () => true,
    },
  )
  try {
    keyOf(spy as never)
  } catch {
    // A key function doing something clever with the row: nothing to learn.
    return []
  }
  return [...new Set(seen)]
}

export const keyFieldsOf = (feed: object): readonly string[] => {
  const stated = keyFields.get(feed)
  if (stated !== undefined) return stated
  const learnt = fieldsRead((feed as { keyOf?: (row: never) => Key }).keyOf ?? (() => ''))
  if (learnt.length > 0) {
    keyFields.set(feed, learnt)
    return learnt
  }
  throw new Error(
    "weft: cannot tell which fields make this feed's key — state them with keyedBy(feed, ...)",
  )
}
