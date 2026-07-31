// The watching side. A mirrored cell is an ordinary stored cell whose single
// writer is the wire, and watching it is what asks the other side for it:
// demand crosses the boundary by itself, so nothing has to be released by hand.

import { input, untracked } from '../core/graph.ts'
import type { Input, Watchable } from '../core/graph.ts'
import { NOT_YET } from './channel.ts'
import type { Channel, Mirrored, ToWatcher } from './channel.ts'

export interface Link {
  /** A cell of the other side, by name; a family needs its key as well. */
  cell<T>(name: string, key?: unknown): Watchable<Mirrored<T>>
  /** A command of the other side. Arguments and the answer must be cloneable. */
  command<A extends readonly unknown[], T>(name: string): (...args: A) => Promise<T>
  close(): void
}

export function link(channel: Channel): Link {
  const mirrors = new Map<string, { id: number; cell: Input<Mirrored<unknown>> }>()
  const byId = new Map<number, Input<Mirrored<unknown>>>()
  const waiting = new Map<
    number,
    { resolve: (value: never) => void; reject: (error: unknown) => void }
  >()
  let next = 1

  const stopListening = channel.listen(raw => {
    const message = raw as ToWatcher
    switch (message?.kind) {
      case 'values':
        for (const { id, value } of message.changed) {
          byId.get(id)?.set({ known: true, value })
        }
        return
      case 'done': {
        const waiter = waiting.get(message.id)
        waiting.delete(message.id)
        waiter?.resolve(message.value as never)
        return
      }
      case 'failed': {
        const waiter = waiting.get(message.id)
        if (waiter !== undefined) {
          waiting.delete(message.id)
          waiter.reject(new Error(message.error))
          return
        }
        // Not a call, then: a cell the other side does not have.
        byId.get(message.id)?.set({ known: false })
        return
      }
      default:
        return
    }
  })

  function mirrorOf(name: string, key: unknown): Input<Mirrored<unknown>> {
    const at = key === undefined ? name : `${name}\u0000${JSON.stringify(key)}`
    const known = mirrors.get(at)
    if (known !== undefined) return known.cell

    const id = next++
    const cell = input<Mirrored<unknown>>(NOT_YET, {
      name: at,
      // Watching here is asking there; nobody watching is nobody asking.
      onDemand: () => channel.send({ kind: 'watch', id, cell: name, key }),
      onIdle: () => {
        channel.send({ kind: 'unwatch', id })
        untracked(() => cell.set(NOT_YET))
      },
    })
    mirrors.set(at, { id, cell })
    byId.set(id, cell)
    return cell
  }

  return {
    cell: <T>(name: string, key?: unknown) =>
      mirrorOf(name, key) as unknown as Watchable<Mirrored<T>>,

    command<A extends readonly unknown[], T>(name: string) {
      return (...args: A): Promise<T> => {
        const id = next++
        const answer = new Promise<T>((resolve, reject) => {
          waiting.set(id, { resolve: resolve as (value: never) => void, reject })
        })
        // An ignored answer must not look like a lost error.
        answer.catch(() => {})
        channel.send({ kind: 'call', id, command: name, args })
        return answer
      }
    },

    close() {
      stopListening()
      for (const waiter of waiting.values()) waiter.reject(new Error('weft: link closed'))
      waiting.clear()
      mirrors.clear()
      byId.clear()
    },
  }
}
