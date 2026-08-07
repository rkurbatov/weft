// A long run, called off from the other side.
//
// The whole chain: a panel writes a new question over a wire, the engine drops
// the run that answered the old one, and the counters say so. Written after the
// chain broke in a way no single package's tests could see — the abort never
// reached the worker, so the run finished work nobody wanted and the counter of
// called-off runs stayed at zero while everything looked healthy.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { subscribe, wirePair } from '#weft'
import { adopt, cell, offer, truthBy } from '#loom'
import { giveWay } from '#weft'
import { settle, until } from '#testkit'

/**
 * An engine whose work takes as long as the test wants it to.
 *
 * Each chunk waits for `step()` to be called, so a question can arrive while a
 * run is genuinely half way through — which is the only interesting moment.
 * A run left to itself here would finish in microseconds and there would be
 * nothing to call off.
 */
function slowEngine() {
  const needle = cell('', { name: 'needle' })
  let letGo: (() => void) | undefined
  const runFor = truthBy<string, number>(
    async (asked, { signal, soFar }) => {
      for (let done = 1; done <= 5; done++) {
        if (signal.aborted) return done
        soFar(done)
        // Waiting for the test, and yielding as a real chunked run does: the
        // yield is what lets the other side be heard at all.
        await new Promise<void>(resolve => {
          letGo = resolve
        })
        await giveWay()
      }
      return asked.length
    },
    { name: 'run', empty: 0 },
  )
  const found = cell(() => runFor(needle.get()).get(), { name: 'found' })
  return { needle, found, tally: runFor.tally, step: () => letGo?.() }
}

describe('calling off a run from the other side of a wire', () => {
  test('a new question drops the run answering the old one', async () => {
    const held = slowEngine()
    const wire = wirePair()
    until(
      offer(
        {
          views: {
            found: held.found,
            asked: held.tally.asked,
            answered: held.tally.answered,
            calledOff: held.tally.calledOff,
          },
          facts: { needle: held.needle },
        },
        wire.graph,
      ),
    )

    const panel = adopt(wire.watcher)
    until(panel.close)
    for (const name of ['found', 'asked', 'answered', 'calledOff']) {
      until(subscribe(panel.view(name), () => {}))
    }
    await settle(3)

    // Let one question run to the end, so the counters start from a settled
    // state — the empty question the panel began with is called off by this
    // first letter, and that is correct, just not what is being measured.
    panel.write('needle', 'first')
    await settle(4)
    for (let i = 0; i < 8; i++) {
      held.step()
      await settle(3)
    }
    const before = {
      asked: held.tally.asked.peek(),
      answered: held.tally.answered.peek(),
      calledOff: held.tally.calledOff.peek(),
    }
    assert.equal(before.answered, 1, 'the first question was answered in full')

    // Now the interesting moment: a question arrives while a run is half way.
    panel.write('needle', 'second')
    await settle(4)
    held.step()
    await settle(3)
    panel.write('needle', 'third')
    await settle(6)

    assert.equal(held.tally.asked.peek() - before.asked, 2, 'two more runs were started')
    assert.equal(
      held.tally.calledOff.peek() - before.calledOff,
      1,
      'the one that was still going got called off',
    )

    for (let i = 0; i < 8; i++) {
      held.step()
      await settle(3)
    }
    assert.equal(held.tally.answered.peek() - before.answered, 1, 'and the last one finished')
    assert.equal(
      held.tally.asked.peek(),
      held.tally.answered.peek() + held.tally.calledOff.peek(),
      'every run is accounted for: started = finished + called off',
    )
  })

  test('the counters reach the panel, not just the engine', async () => {
    const held = slowEngine()
    const wire = wirePair()
    until(
      offer(
        {
          views: { found: held.found, calledOff: held.tally.calledOff },
          facts: { needle: held.needle },
        },
        wire.graph,
      ),
    )
    const panel = adopt(wire.watcher)
    until(panel.close)
    // Watching the answer is what makes the engine work at all: no demand, no
    // run, and nothing to call off.
    until(subscribe(panel.view('found'), () => {}))
    until(subscribe(panel.view('calledOff'), () => {}))
    await settle(3)

    panel.write('needle', 'one')
    await settle(4)
    // The run for 'one' is half way; 'two' replaces the question.
    panel.write('needle', 'two')
    await settle(8)

    assert.ok(held.tally.calledOff.peek() > 0, 'the engine counted a call-off')
    assert.equal(
      panel.view<number>('calledOff').peek(),
      held.tally.calledOff.peek(),
      'and the panel is looking at the same number',
    )
  })

  test('a question left alone finishes, and nothing is called off', async () => {
    const held = slowEngine()
    until(subscribe(held.found, () => {}))
    await settle(3)

    held.needle.set('alone')
    await settle(4)
    const before = held.tally.calledOff.peek()
    for (let i = 0; i < 8; i++) {
      held.step()
      await settle(3)
    }

    assert.ok(held.tally.answered.peek() >= 1, 'it finished')
    assert.equal(held.tally.calledOff.peek(), before, 'finishing is not being called off')
  })
})
