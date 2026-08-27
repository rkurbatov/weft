import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { port, derived, subscribe } from '#graph'
import { family } from '#graph'
import type { Derived, Family } from '#graph'
import { until } from '#testkit'

describe('families of cells', () => {
  test('same key gives the same cell, different keys different cells', () => {
    const table = port(new Map([['a', 1]]))
    const item = family((id: string) => table.get().get(id) ?? 0)
    assert.equal(item('a'), item('a'))
    assert.notEqual(item('a'), item('b'))
    assert.equal(item('a').peek(), 1)
    assert.equal(item('b').peek(), 0)
  })

  test('lazy: a member nobody asked for is never built', () => {
    let built = 0
    const item = family((id: string) => {
      built++
      return id.toUpperCase()
    })
    assert.equal(built, 0)
    assert.equal(item('x').peek(), 'X')
    assert.equal(built, 1)
    item('x').peek()
    assert.equal(built, 1)
  })

  test('a member reacts to its own row only', () => {
    const rows = port(
      new Map([
        ['a', 1],
        ['b', 1],
      ]),
    )
    let runs = 0
    const item = family((id: string) => {
      runs++
      return rows.get().get(id) ?? 0
    })
    const stopA = subscribe(item('a'), () => {})
    until(subscribe(item('b'), () => {}))
    runs = 0
    rows.set(
      new Map([
        ['a', 2],
        ['b', 1],
      ]),
    )
    assert.equal(item('a').peek(), 2)
    assert.equal(item('b').peek(), 1)
    // Both recompute — they read the whole map — but 'b' produced an equal value
    // and therefore did not wake its watcher.
    assert.equal(runs, 2)
    stopA()
  })

  test('watched members do not wake on unrelated writes', () => {
    const rows = port(
      new Map([
        ['a', 1],
        ['b', 1],
      ]),
    )
    const item = family((id: string) => rows.get().get(id) ?? 0)
    let wokeA = 0
    let wokeB = 0
    const stopA = subscribe(item('a'), () => wokeA++)
    until(subscribe(item('b'), () => wokeB++))
    rows.set(
      new Map([
        ['a', 2],
        ['b', 1],
      ]),
    )
    assert.equal(wokeA, 1)
    assert.equal(wokeB, 0)
    stopA()
  })

  test('unwatched members are evicted past the ceiling, watched ones are kept', () => {
    const item = family((id: number) => id * 2, { max: 3 })
    until(subscribe(item(1), () => {}))
    item(2)
    item(3)
    item(4)
    item(5)
    assert.equal(item(1).observed, true)
    assert.ok(item.size <= 4, `size ${item.size}`)
    assert.equal(item.has(1), true)
  })

  test('eviction is refused while somebody watches', () => {
    const item = family((id: string) => id)
    const stop = subscribe(item('a'), () => {})
    assert.equal(item.evict('a'), false)
    stop()
    assert.equal(item.evict('a'), true)
    assert.equal(item.has('a'), false)
  })

  test('a rebuilt member computes again and is correct', () => {
    const source = port(1)
    let builds = 0
    const item = family((id: string) => {
      builds++
      return `${id}:${source.get()}`
    })
    assert.equal(item('a').peek(), 'a:1')
    assert.equal(builds, 1)
    assert.equal(item.evict('a'), true)
    source.set(2)
    assert.equal(item('a').peek(), 'a:2')
    assert.equal(builds, 2)
  })

  test('evicted member stops hearing its sources', () => {
    const source = port(1)
    let runs = 0
    const item = family((_id: string) => {
      runs++
      return source.get()
    })
    const member = item('a')
    member.peek()
    assert.equal(runs, 1)
    item.evict('a')
    source.set(2)
    member.peek() // rebuilt on demand, not driven by the write
    assert.equal(runs, 2)
  })

  test('sweep drops the unwatched and counts them', () => {
    const item = family((id: number) => id)
    until(subscribe(item(1), () => {}))
    item(2)
    item(3)
    assert.equal(item.sweep(), 2)
    assert.equal(item.size, 1)
    assert.equal(item.has(1), true)
  })

  test('a formula over a member depends on it', () => {
    const rows = port(new Map([['a', 2]]))
    const item = family((id: string) => rows.get().get(id) ?? 0)
    const doubled = derived(() => item('a').get() * 10)
    let seen = 0
    until(subscribe(doubled, () => seen++))
    assert.equal(doubled.peek(), 20)
    rows.set(new Map([['a', 3]]))
    assert.equal(doubled.peek(), 30)
    assert.equal(seen, 1)
  })

  test('object keys need nameOf, and then behave like any other', () => {
    type At = { row: number; col: number }
    assert.throws(() => family((k: At) => k.row)({ row: 1, col: 1 }), /nameOf/)
    const at = family((k: At) => `${k.row}/${k.col}`, { nameOf: k => `${k.row}:${k.col}` })
    assert.equal(at({ row: 1, col: 2 }), at({ row: 1, col: 2 }))
    assert.equal(at({ row: 1, col: 2 }).peek(), '1/2')
    assert.equal(at.size, 1)
  })

  test('the member just asked for is never the one dropped to make room', () => {
    const item = family((id: number) => id, { max: 2 })
    const stopOne = subscribe(item(1), () => {})
    until(subscribe(item(2), () => {}))
    // Both standing members are watched, so neither counts against the ceiling
    // and the newborn is within it. Room is made before it joins, so it cannot
    // be the candidate for its own arrival.
    const three = item(3)
    assert.equal(item.has(3), true)
    assert.equal(item(3), three)
    stopOne()
  })

  test('the ceiling counts unwatched members, watched ones stand outside it', () => {
    const item = family((id: number) => id, { max: 2 })
    const stopOne = subscribe(item(1), () => {})
    until(subscribe(item(2), () => {}))
    item(3)
    item(4)
    item(5)
    assert.equal(item.has(1), true)
    assert.equal(item.has(2), true)
    // Two watched standing outside the ceiling, two cold under it.
    assert.equal(item.size, 4)
    assert.equal(item.has(3), false)
    assert.equal(item.has(5), true)
    stopOne()
  })

  test('a family that caches nothing still hands back a live member', () => {
    const item = family((id: number) => id, { max: 0 })
    const one = item(1)
    assert.equal(item(1), one)
    const two = item(2)
    assert.equal(item.has(1), false)
    assert.equal(item(2), two)
    assert.equal(two.peek(), 2)
  })

  test('a member building its own children is not dropped to make room for them', () => {
    // A fold over blocks: the upper part reads eight lower ones, and the family
    // is small enough that the children push the ceiling while their parent is
    // still on the stack.
    const part: (key: string) => Derived<number> = family(
      (key: string): number => {
        if (key.startsWith('leaf:')) return Number(key.slice(5))
        let sum = 0
        for (let i = 0; i < 8; i++) sum += part(`leaf:${i}`).get()
        return sum
      },
      { max: 4 },
    )
    assert.equal(part('sum').peek(), 28)
  })

  test('what the cache holds does not depend on the order watched and cold stand in', () => {
    // The ceiling bounds the members nobody is reading. How many of those
    // survive an admission is arithmetic, and arithmetic does not care whether
    // the watched members happen to lie ahead of the cold ones in the map.
    const run = (watchedFirst: boolean) => {
      const item = family((id: number) => id, { max: 4 })
      const cells = new Map<number, Derived<number>>()
      const made = (id: number): Derived<number> => {
        const cell = item(id)
        cells.set(id, cell)
        return cell
      }
      const stops: (() => void)[] = []
      const watch = () => {
        for (const id of [1, 2, 3]) stops.push(subscribe(made(id), () => {}))
      }
      const chill = () => {
        for (const id of [4, 5, 6]) made(id)
      }
      if (watchedFirst) {
        watch()
        chill()
      } else {
        chill()
        watch()
      }
      const cold = () => [...cells].filter(([id, c]) => item.has(id) && !c.observed).length
      assert.equal(cold(), 3, 'three cold, one under the ceiling')

      made(7) // cold would be four, which is the ceiling: nobody goes
      assert.equal(cold(), 4)
      assert.equal(item.size, 7)

      made(8) // now one too many: the oldest cold member goes, and only it
      assert.equal(cold(), 4)
      assert.equal(item.size, 7)
      assert.equal(item.has(4), false, 'the oldest cold member is the one that goes')
      assert.equal(item.has(5), true)
      for (const id of [1, 2, 3]) assert.equal(item.has(id), true, 'watched members stay')
      for (const stop of stops) stop()
      return item.size
    }
    assert.equal(run(true), run(false))
  })

  test('every way out refuses a member whose formula is running', () => {
    // All three used to test for watchers and then dispose, which throws on a
    // cell that is mid-formula. Whichever one is called, the answer is now no.
    for (const attempt of [
      (item: Family<number, number>, id: number) => assert.equal(item.evict(id), false),
      (item: Family<number, number>, _id: number) => assert.equal(item.sweep(), 0),
    ]) {
      let item!: Family<number, number>
      item = family((id: number) => {
        attempt(item, id)
        return id
      })
      assert.equal(item(1).peek(), 1)
      assert.equal(item.has(1), true)
    }
  })

  test('a member on the stack stands over the ceiling until the next admission', () => {
    // `max: 0` is the sharpest case: every member is one too many, so what is
    // held is exactly what could not be let go of.
    let part!: Family<string, number>
    part = family((key: string) => (key === 'parent' ? part('child').peek() : 1), { max: 0 })
    assert.equal(part('parent').peek(), 1)
    assert.equal(part.size, 2, 'the parent was running and the child was being handed back')
    part('other') // the next admission finds both of them ordinary again
    assert.equal(part.size, 1)
    assert.equal(part.sweep(), 1, 'and sweep takes what admissions have not reached')
  })

  test('letting a member go turns what it held cold, and the same pass takes it', () => {
    // The parent reads the child, so while the parent lives the child is
    // watched and outside the ceiling. Dropping the parent makes the child a
    // cache entry mid-pass, and the pass has to notice.
    let item!: Family<number, number>
    item = family((id: number) => (id === 1 ? item(2).get() : id), { max: 1 })
    item(1).peek()
    item(3)
    assert.deepEqual(item.keys().toSorted(), [3], 'the whole chain the parent held went with it')
  })

  test('sweep reaches everything that became free while it ran, whatever the order', () => {
    // The child was built first, so a walk of the map meets it while it is
    // still watched by the parent and would leave it behind.
    let item!: Family<number, number>
    item = family((id: number) => (id === 1 ? item(2).get() : id), { max: 10 })
    item(2)
    item(1).peek()
    assert.equal(item.sweep(), 2)
    assert.deepEqual(item.keys().toSorted(), [])
  })

  test('a member enters the cache when it stops being read, not when it was built', () => {
    // And the ceiling is kept when watchers leave, without waiting for a new
    // key: 1 was built first but cooled last, so the oldest cache entry is 2.
    const item = family((id: number) => id, { max: 2 })
    const stop = subscribe(item(1), () => {})
    item(2)
    item(3)
    assert.equal(item.size, 3)
    stop()
    assert.equal(item.size, 2, 'the ceiling is kept the moment the cache goes over it')
    assert.equal(item.has(2), false, 'the oldest cache entry goes')
    assert.equal(item.has(1), true, 'the one that just cooled is the youngest, not the oldest')
    assert.equal(item.has(3), true)
  })

  test('keys of different kinds are different members here too', () => {
    // The same law as the query cache, run on this side as well: the two grew
    // apart over exactly this once, and one witness each is what keeps them
    // from doing it again.
    const mixed = family((key: string | number | boolean | bigint) => key, { max: 10 })
    assert.notEqual(mixed(1), mixed('1'))
    assert.notEqual(mixed(true), mixed('true'))
    assert.notEqual(mixed(1), mixed(1n))
    assert.equal(mixed.size, 5)
  })

  test('a ceiling is a whole count of none or more', () => {
    // Safe, not merely whole: past MAX_SAFE_INTEGER a cache cannot count up to
    // its own ceiling, so `Number.isInteger` in place of `isSafeInteger` must go
    // red here.
    for (const bad of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assert.throws(() => family((id: number) => id, { max: bad }), RangeError)
    }
    assert.doesNotThrow(() => family((id: number) => id, { max: 0 }))
    assert.doesNotThrow(() => family((id: number) => id, { max: Number.MAX_SAFE_INTEGER }))
  })

  test('a member read after another went cold outlives it', () => {
    // The law both caches keep, whatever their order underneath: `a` was read
    // after `b` was already a cache entry, so one automatic eviction cannot
    // spare `b` by taking `a`.
    //
    // Negative control: forget reads made below the ceiling — as the family did
    // before — and `a` goes instead.
    const item = family((id: string) => id, { max: 3 })
    item('a')
    item('b')
    item('a')
    item('c')
    item('d')
    assert.equal(item.evict('b'), false, 'b was the one taken')
    assert.equal(item.evict('a'), true, 'a survived the pass')
  })

  test('a second chance is spent, not renewed', () => {
    const item = family((id: string) => id, { max: 2 })
    item('a')
    item('b')
    item('a') // a is marked
    item('c') // the pass skips a, takes b
    assert.equal(item.evict('b'), false)
    item('d') // and now a has no mark left
    assert.equal(item.evict('a'), false, 'the chance was spent')
  })

  test('evict and sweep do not treat a mark as protection', () => {
    const item = family((id: string) => id, { max: 4 })
    item('a')
    item('b')
    item('a')
    item('b')
    assert.equal(item.evict('a'), true, 'evict ignores the mark')
    assert.equal(item.sweep(), 1, 'and so does sweep')
    assert.equal(item.size, 0)
  })

  test('when everything is marked the ceiling is still kept', () => {
    // Termination: a pass that spared everybody would leave the ceiling broken
    // until somebody asked another question. The second round is what makes it
    // a promise.
    const item = family((id: number) => id, { max: 3 })
    for (const id of [1, 2, 3]) item(id)
    for (const id of [1, 2, 3]) item(id) // all marked
    item(4)
    assert.equal(item.size, 3)
    assert.equal(item.has(1), false, 'the oldest went, marked or not')
  })

  test('a watched member survives every drop path', () => {
    const item = family((id: number) => id, { max: 1 })
    const stop = subscribe(item(1), () => {})
    item(2)
    item(3)
    item.sweep()
    assert.equal(item.evict(1), false)
    assert.equal(item.has(1), true)
    assert.equal(item(1).observed, true)
    stop()
    assert.equal(item.evict(1), true)
  })
})
