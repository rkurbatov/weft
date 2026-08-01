// The watching side. A mirrored cell is an ordinary stored cell whose single
// writer is the wire, and watching it is what asks the other side for it:
// demand crosses the boundary by itself, so nothing has to be released by hand.

import { input, untracked } from '../core/graph.ts'
import type { Input, Watchable } from '../core/graph.ts'
import { EMPTY, arrived, refused } from '../core/remote.ts'
import type { Remote } from '../core/remote.ts'
import type { Channel, ToWatcher } from './channel.ts'

/**
 * The call got no answer and never will — but the other side may have done the
 * work. Not a refusal: a refusal means the graph said no, this means nobody
 * knows. Retrying is safe only if the command itself is.
 */
export class UnknownOutcome extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnknownOutcome'
  }
}

export interface Link {
  /** Ask again for everything being watched. Called for you when the other side announces itself. */
  rewatch(): void
  /** A cell of the other side, by name; a family needs its key as well. */
  cell<T>(name: string, key?: unknown): Watchable<Remote<T>>
  /** A command of the other side. Arguments and the answer must be cloneable. */
  command<A extends readonly unknown[], T>(name: string): (...args: A) => Promise<T>
  close(): void
}

export function link(channel: Channel): Link {
  const mirrors = new Map<string, { id: number; cell: Input<Remote<unknown>> }>()
  const byId = new Map<number, Input<Remote<unknown>>>()
  const waiting = new Map<
    number,
    { resolve: (value: never) => void; reject: (error: unknown) => void }
  >()
  let next = 1

  const stopListening = channel.listen(raw => {
    const message = raw as ToWatcher
    switch (message?.kind) {
      case 'up': {
        // A fresh graph knows nothing of calls sent to the old one. Their
        // answers died with it — which is not the same as a refusal.
        for (const waiter of waiting.values()) {
          waiter.reject(new UnknownOutcome('weft: the graph restarted before answering'))
        }
        waiting.clear()
        rewatch()
        return
      }
      case 'values':
        for (const { id, value } of message.changed) {
          byId.get(id)?.set(arrived(value, Date.now()))
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
        // Not a call, then: a cell the other side does not have — a refusal,
        // told apart from "nothing arrived yet".
        const mirror = byId.get(message.id)
        mirror?.set(refused(mirror.peek(), new Error(message.error), 1, 'rejected'))
        return
      }
      default:
        return
    }
  })

  /** Ask again for everything somebody is still watching. */
  function rewatch(): void {
    for (const [at, mirror] of mirrors) {
      if (!mirror.cell.demanded) continue
      const [name, rawKey] = at.split('\u0000')
      channel.send({
        kind: 'watch',
        id: mirror.id,
        cell: name,
        key: rawKey === undefined ? undefined : (JSON.parse(rawKey) as unknown),
      })
    }
  }

  function mirrorOf(name: string, key: unknown): Input<Remote<unknown>> {
    const at = key === undefined ? name : `${name}\u0000${JSON.stringify(key)}`
    const known = mirrors.get(at)
    if (known !== undefined) return known.cell

    const id = next++
    const cell = input<Remote<unknown>>(EMPTY, {
      name: at,
      // Watching here is asking there; nobody watching is nobody asking.
      onDemand: () => channel.send({ kind: 'watch', id, cell: name, key }),
      onIdle: () => {
        channel.send({ kind: 'unwatch', id })
        untracked(() => cell.set(EMPTY))
      },
    })
    mirrors.set(at, { id, cell })
    byId.set(id, cell)
    return cell
  }

  return {
    rewatch,
    cell: <T>(name: string, key?: unknown) =>
      mirrorOf(name, key) as unknown as Watchable<Remote<T>>,

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
      // Let the graph go: watches we leave behind would hold demand there
      // forever. A dead wire may refuse the send — closing must not fail on it.
      try {
        for (const { id, cell } of mirrors.values()) {
          if (cell.demanded) channel.send({ kind: 'unwatch', id })
        }
      } catch {
        // The other side is gone, then; there is nothing to release.
      }
      stopListening()
      for (const waiter of waiting.values()) {
        waiter.reject(new UnknownOutcome('weft: the link closed before an answer came'))
      }
      waiting.clear()
      mirrors.clear()
      byId.clear()
    },
  }
}
