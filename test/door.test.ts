import assert from 'node:assert/strict'
import { test } from 'node:test'
import { command, CommandReset } from '#weft'
import { world } from '#testkit'

test('a start taken back is told apart from a refusal, at the door an application uses', async () => {
  const clock = world()
  const save = command(async (text: string) => text.length, { calm: 100, timers: clock.timers })
  const held = save.run('hi')
  save.reset()
  await assert.rejects(held, (error: unknown) => error instanceof CommandReset)
  await clock.advance(500)
  assert.equal(save.state.peek().kind, 'idle')
})
