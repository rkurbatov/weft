import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { derived, subscribe, trace } from '#weft'
import { truthBy } from '#loom'
import { settle, world } from '#testkit'

// That a `Truth` applies the self-releasing cell correctly — checked on the
// edge it holds, not on who reads it. The defect these guard was exactly the
// difference: after a bare look the face had no readers of its own and was
// still an observer of the source, for ever.

interface Task {
  id: number
  title: string
}

describe('a face holds its source only while somebody reads it', () => {
  const make = () => {
    const clock = world()
    const detail = truthBy((id: number) => Promise.resolve({ id, title: `task ${String(id)}` }), {
      name: 'bridge',
      timers: clock.timers,
      empty: { id: 0, title: '' } as Task,
      keep: 8,
    })
    return { detail, clock }
  }

  test('one look at a face leaves no link behind it', async () => {
    const { detail } = make()
    const face = detail(1)
    face.peek()
    face.flight.peek()
    face.fault.peek()
    face.asked.peek()
    await settle(2)
    for (const [what, cell] of [
      ['flight', face.flight],
      ['fault', face.fault],
      ['asked', face.asked],
    ] as const) {
      assert.deepEqual(trace(cell).reads, [], `${what} let the source go`)
    }
  })

  test('the value behind the face lets go too, and it is the one that hides', () => {
    // `value` is reached through `Truth.get/peek`, so a trace of it is not to
    // be had directly. One legitimately held face shows the source, and the
    // source says who is still reading it — which is the whole question.
    const reads: ((face: { get(): Task; peek(): Task }) => Task)[] = [
      face => face.get(),
      face => face.peek(),
    ]
    for (const read of reads) {
      const { detail } = make()
      const face = detail(9)
      const stop = subscribe(face.flight, () => {})
      read(face)
      const state = trace(face.flight).reads?.[0]
      assert.ok(state !== undefined, 'the held face still reads the source')
      assert.deepEqual(
        state.readBy.filter(name => name.endsWith('.value')),
        [],
        'a bare read of the value did not stay attached to the source',
      )
      stop()
    }
  })

  test('a formula that read a face once holds it, until it is disposed', async () => {
    const { detail } = make()
    const face = detail(2)
    const bridge = derived(() => face.flight.get())
    bridge.peek()
    assert.equal(trace(face.flight).reads?.length, 1, 'a reader that stays holds the link')
    bridge.dispose()
    await settle(2)
    assert.deepEqual(trace(face.flight).reads, [], 'and it goes with the reader')
  })

  test('two faces of one truth are held and let go on their own', async () => {
    const { detail } = make()
    const face = detail(3)
    const stopValue = subscribe(face, () => {})
    const stopFlight = subscribe(face.flight, () => {})
    await settle(2)
    stopValue()
    await settle(2)
    assert.equal(trace(face.flight).reads?.length, 1, 'the one still read holds on')
    stopFlight()
    await settle(2)
    assert.deepEqual(trace(face.flight).reads, [])
  })
})

describe('the faces of one truth change on their own', () => {
  test('a value arriving in pieces does not wake a listener on the flight', async () => {
    const clock = world()
    let report!: (value: Task) => void
    let finish!: (value: Task) => void
    const detail = truthBy(
      (id: number, { soFar }: { signal: AbortSignal; soFar: (value: Task) => void }) => {
        report = soFar
        return new Promise<Task>(resolve => {
          finish = (value: Task) => resolve(value)
          void id
        })
      },
      { name: 'pieces', timers: clock.timers, empty: { id: 0, title: '' } as Task, keep: 8 },
    )

    const face = detail(4)
    let flights = 0
    const stop = subscribe(face.flight, () => flights++)
    await settle(3)
    const beforePartial = flights

    report({ id: 4, title: 'half' })
    await settle(3)
    // The state really changed and the value with it; the projection did not.
    assert.equal(face.peek().title, 'half')
    assert.equal(face.flight.peek(), true)
    assert.equal(flights, beforePartial, 'a listener sees only its own value change')

    finish({ id: 4, title: 'whole' })
    await settle(3)
    assert.equal(face.flight.peek(), false, 'and it does hear the flight end')
    stop()
  })
})
