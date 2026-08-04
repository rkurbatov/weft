// A region owns a piece of the graph. Everything created while it builds —
// cells, watchers, sources, outboxes — is remembered and let go in one move,
// in reverse order of birth. Regions nest; names nest with them, so a cell
// born inside region "kanban" carries "kanban." on its name.
//
// The region is what makes a module of the store autonomous: it can be raised,
// used, and taken down whole, with nothing left ticking behind it.

interface Owner {
  name: string
  teardowns: Array<() => void>
}

let current: Owner | null = null

/** Give the enclosing region something to let go of. No region — no-op. */
export function owned(teardown: () => void): void {
  current?.teardowns.push(teardown)
}

/** The name prefix of the enclosing region, if any. */
export function regionName(): string | undefined {
  return current?.name
}

export interface Region<T> {
  readonly name: string
  readonly value: T
  dispose(): void
}

export function region<T>(name: string, build: () => T): Region<T> {
  const owner: Owner = {
    name: current === null ? name : `${current.name}.${name}`,
    teardowns: [],
  }
  const before = current
  current = owner
  let value: T
  try {
    value = build()
  } finally {
    current = before
  }
  let dead = false
  return {
    name: owner.name,
    value,
    dispose() {
      if (dead) return
      dead = true
      for (let i = owner.teardowns.length - 1; i >= 0; i--) owner.teardowns[i]?.()
    },
  }
}
