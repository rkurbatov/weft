import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { port, derived, subscribe, untracked } from '#graph'
import { command, CommandReset, onCommandFailure } from '#graph'
import { settle, track, world } from '#testkit'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('start, await, observe: state walks idle -> running -> done', async () => {
  const gate = deferred<number>()
  const cmd = command(async () => gate.promise)
  const seen = track(cmd.state, s => s.kind)
  assert.equal(cmd.state.peek().kind, 'idle')
  const answer = cmd.run()
  assert.equal(cmd.pending.peek(), true)
  gate.resolve(7)
  assert.equal(await answer, 7)
  assert.equal(cmd.pending.peek(), false)
  assert.equal(cmd.result.peek(), 7)
  seen.said(['running', 'done'])
})

test('failure is a state, not an unhandled throw at the edge', async () => {
  const cmd = command(async () => {
    throw new Error('refused')
  })
  await assert.rejects(cmd.run(), /refused/)
  assert.equal(cmd.pending.peek(), false)
  assert.match(String((cmd.error.peek() as Error).message), /refused/)
  assert.equal(cmd.state.peek().kind, 'failed')
})

test('drop (default): a second press rides the first, body runs once', async () => {
  let bodies = 0
  const gate = deferred<string>()
  const cmd = command(async () => {
    bodies++
    return gate.promise
  })
  const first = cmd.run()
  const second = cmd.run()
  gate.resolve('ok')
  assert.equal(await first, 'ok')
  assert.equal(await second, 'ok')
  assert.equal(bodies, 1)
})

test('restart: the older answer is ignored, not applied late', async () => {
  const slow = deferred<string>()
  const fast = deferred<string>()
  const gates = [slow, fast]
  let n = 0
  const cmd = command(async () => gates[n++]!.promise, { whileRunning: 'restart' })
  const stale = cmd.run()
  const fresh = cmd.run()
  fast.resolve('new')
  assert.equal(await fresh, 'new')
  assert.equal(cmd.result.peek(), 'new')
  slow.resolve('old')
  await stale
  assert.equal(cmd.result.peek(), 'new')
})

test('reset forgets the outcome and disowns what is in flight', async () => {
  const gate = deferred<number>()
  const cmd = command(async () => gate.promise)
  const answer = cmd.run()
  cmd.reset()
  assert.equal(cmd.state.peek().kind, 'idle')
  gate.resolve(1)
  assert.equal(await answer, 1)
  assert.equal(cmd.state.peek().kind, 'idle')
})

test('pending is a cell: formulas may depend on it', async () => {
  const gate = deferred<void>()
  const cmd = command(async () => gate.promise)
  const enabled = port(true)
  const clickable = derived(() => enabled.get() && !cmd.pending.get())
  assert.equal(clickable.peek(), true)
  const answer = cmd.run()
  assert.equal(clickable.peek(), false)
  gate.resolve()
  await answer
  assert.equal(clickable.peek(), true)
})

test('store shape React needs: stable snapshot, change notification, dispose', () => {
  const source = port(1)
  const view = derived(() => source.get() * 2)
  const snapshot = () => untracked(() => view.get())
  let notified = 0
  const stop = subscribe(view, () => notified++)
  assert.equal(snapshot(), 2)
  assert.equal(snapshot(), 2) // same call, no recompute, no tearing
  source.set(5)
  assert.equal(notified, 1)
  assert.equal(snapshot(), 10)
  stop()
  source.set(9)
  assert.equal(notified, 1)
})

describe('a command asked to wait for quiet', () => {
  test('the last start within the quiet is the one that runs', async () => {
    const clock = world()
    const asked: string[] = []
    const search = command(
      async (text: string) => {
        asked.push(text)
        return text.length
      },
      { calm: 300, timers: clock.timers },
    )

    const first = search.run('a')
    const second = search.run('ab')
    const third = search.run('abc')
    await clock.advance(100)
    assert.deepEqual(asked, [], 'still typing')

    await clock.advance(300)
    assert.deepEqual(asked, ['abc'], 'only the last one happened')

    // And nobody is left waiting: the earlier callers get the answer that ran.
    assert.deepEqual(await Promise.all([first, second, third]), [3, 3, 3])
  })

  test('reset takes back a start that was still waiting out the quiet', async () => {
    const clock = world()
    const asked: string[] = []
    const search = command(
      async (text: string) => {
        asked.push(text)
        return text.length
      },
      { calm: 300, timers: clock.timers },
    )

    const first = search.run('a')
    const second = search.run('ab')
    const outcome = Promise.all(
      [first, second].map(held => held.then(() => 'ran', (error: unknown) => String(error))),
    )
    search.reset()

    await clock.advance(1000)
    assert.deepEqual(asked, [], 'the body of a start that was taken back never runs')
    assert.equal(search.state.peek().kind, 'idle', 'and nothing lands on the state later')
    // Everyone still on the wait hears about it, not just the last caller.
    const said = await outcome
    assert.equal(said.length, 2)
    for (const one of said) assert.match(one, /was reset before it started/)
    await assert.rejects(first, (error: unknown) => error instanceof CommandReset)
  })

  test('a crowd waiting out one quiet is a list, not a stack of frames', async () => {
    const clock = world()
    let asked = 0
    const search = command(
      async (text: string) => {
        asked++
        return text.length
      },
      { calm: 300, timers: clock.timers },
    )

    const waiting = Array.from({ length: 20_000 }, (_, i) => search.run(`q${String(i)}`))
    await clock.advance(300)
    assert.equal(asked, 1, 'one start for twenty thousand keystrokes')
    const answers = await Promise.all(waiting)
    assert.equal(answers.length, 20_000)
    assert.equal(new Set(answers).size, 1, 'and all of them hold the same answer')
  })

  test('a refusal by the world is not silenced by asking for quiet', async () => {
    const clock = world()
    const told: string[] = []
    const stopTelling = onCommandFailure((_error, command_) => told.push(command_))
    const save = command(
      async () => {
        throw new Error('server said no')
      },
      { name: 'save', calm: 100, timers: clock.timers },
    )
    const held = save.run()
    await clock.advance(100)
    await assert.rejects(held, /server said no/)
    assert.equal(save.state.peek().kind, 'failed')
    assert.deepEqual(told, ['save'], 'told once, exactly as it would be without a quiet')
    stopTelling()
  })

  test('without a quiet asked for, a start is a start', async () => {
    const asked: string[] = []
    const save = command(async (text: string) => {
      asked.push(text)
      return text
    })
    await save.run('now')
    assert.deepEqual(asked, ['now'])
  })
})

describe('a refusal nobody awaited', () => {
  test('goes to the command’s own handler', async () => {
    const caught: Array<{ error: unknown; name: string }> = []
    const save = command(() => Promise.reject(new Error('the disk said no')), {
      name: 'save',
      onError: (error, name) => caught.push({ error, name }),
    })

    // Started and not awaited, as a fire-and-forget save would be.
    void save.run()
    await settle(2)

    assert.equal(caught.length, 1)
    assert.equal(caught[0]?.name, 'save')
    assert.match(String(caught[0]?.error), /disk said no/)
    assert.equal(save.state.peek().kind, 'failed', 'and the state still says so')
  })

  test('goes to the standing handler when the command has none', async () => {
    const caught: string[] = []
    const stop = onCommandFailure((_error, name) => caught.push(name))

    const sync = command(() => Promise.reject(new Error('offline')), { name: 'sync' })
    void sync.run()
    await settle(2)
    assert.deepEqual(caught, ['sync'])

    stop()
    const quiet = command(() => Promise.reject(new Error('offline')), { name: 'after' })
    quiet.run().catch(() => {})
    await settle(2)
    assert.deepEqual(caught, ['sync'], 'the standing handler is gone with its lease')
  })

  test('a handler does not swallow it: whoever awaits still gets the refusal', async () => {
    const caught: unknown[] = []
    const save = command(() => Promise.reject(new Error('no')), {
      name: 'save',
      onError: error => caught.push(error),
    })

    await assert.rejects(() => save.run(), /no/)
    await settle(2)
    assert.equal(caught.length, 1)
  })
})