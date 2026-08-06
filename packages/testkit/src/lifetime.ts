// Cleanup that happens whether the test passes or not.
//
// The old shape was `const stop = subscribe(...)` at the top and `stop()` at
// the bottom, with the assertions in between — so a failing assertion skipped
// the cleanup, and the next test inherited a live watcher, a held lock, or a
// bus that keeps the process alive. Those hunts cost hours; a failing test
// should cost only its own failure.
//
// Anything registered here is let go of in reverse order of registration,
// after every test, in `afterEach`. Nothing in a test body needs to remember.

import { afterEach } from 'node:test'

type Teardown = () => void

const stack: Teardown[] = []

/** Let go of this when the test ends. Returns whatever was passed, for chaining. */
export function cleanupWith(teardown: Teardown): void {
  stack.push(teardown)
}

/** Keep this alive for the test and dispose of it afterwards. */
export function held<T extends { dispose(): void }>(thing: T): T {
  cleanupWith(() => thing.dispose())
  return thing
}

/** Keep this subscription for the test and stop it afterwards. */
export function until<T extends Teardown>(stop: T): T {
  cleanupWith(stop)
  return stop
}

/** Anything with a close: a bus, a wire, a station. */
export function closing<T extends { close(): void }>(thing: T): T {
  cleanupWith(() => thing.close())
  return thing
}

afterEach(() => {
  const failures: unknown[] = []
  while (stack.length > 0) {
    const teardown = stack.pop()
    try {
      teardown?.()
    } catch (error) {
      // Carry on: one broken teardown must not leave the rest in place — that
      // is the very thing this file exists to prevent.
      failures.push(error)
    }
  }
  if (failures.length > 0) throw failures[0]
})
