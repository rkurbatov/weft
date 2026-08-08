// The shared tests, in place: the domain runs right here, propagation is a breath.

import { region } from '#weft'
import { kanban } from './state.ts'
import { kanbanSuite } from './suite.ts'
import type { Make } from './suite.ts'

const make: Make = (server, pollMs) => {
  const box = region('kanban', () => kanban(server, pollMs))
  return {
    app: box.value,
    settle: () => new Promise(resolve => setTimeout(resolve, 1)),
    dispose: () => {
      box.value.dispose()
      box.dispose()
    },
  }
}

kanbanSuite('in place', make)
