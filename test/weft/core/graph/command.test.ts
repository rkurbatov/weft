import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { input, cell, subscribe, untracked } from '#weft/core/graph/graph.ts'
import { command } from '#weft/core/graph/command.ts'
import { world } from '../../../kit/index.ts'

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
  const seen: string[] = []
  const stop = subscribe(cmd.state, s => seen.push(s.kind))
  assert.equal(cmd.state.peek().kind, 'idle')
  const answer = cmd.run()
  assert.equal(cmd.pending.peek(), true)
  gate.resolve(7)
  assert.equal(await answer, 7)
  assert.equal(cmd.pending.peek(), false)
  assert.equal(cmd.result.peek(), 7)
  assert.deepEqual(seen, ['running', 'done'])
  stop()
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
  const enabled = input(true)
  const clickable = cell(() => enabled.get() && !cmd.pending.get())
  assert.equal(clickable.peek(), true)
  const answer = cmd.run()
  assert.equal(clickable.peek(), false)
  gate.resolve()
  await answer
  assert.equal(clickable.peek(), true)
})

test('store shape React needs: stable snapshot, change notification, dispose', () => {
  const source = input(1)
  const view = cell(() => source.get() * 2)
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
