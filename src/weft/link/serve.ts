// The graph's side of the wire. It publishes named cells and named commands and
// answers whoever asks. Watching from the other side is ordinary demand: the
// first watcher wakes whatever the cell depends on, the last one lets it go.

import { subscribe, untracked } from '../core/graph/graph.ts'
import type { Watchable } from '../core/graph/graph.ts'
import { perFrame } from './channel.ts'
import type { Channel, Schedule, ToGraph } from './channel.ts'

export interface Surface {
  /** Cells anyone may watch, by name. */
  cells?: Readonly<Record<string, Watchable<unknown>>>
  /** Cells that need a key: a family, by name. */
  families?: Readonly<Record<string, (key: never) => Watchable<unknown>>>
  /** What the other side may ask for. Arguments and answers must be cloneable. */
  commands?: Readonly<Record<string, (...args: never[]) => unknown>>
  /** Facts the other side may write into. Writing outside these is refused. */
  facts?: Readonly<Record<string, { set(value: never): void }>>
}

export interface ServeOptions {
  /** When to flush what has changed. Once a frame by default. */
  schedule?: Schedule
  /** Told when a value cannot be sent — usually because it is not cloneable. */
  onUnsendable?: (cell: string, error: unknown) => void
}

export function serve(surface: Surface, channel: Channel, options: ServeOptions = {}): () => void {
  const schedule = options.schedule ?? perFrame
  const watching = new Map<number, () => void>()
  // The latest value per watch, not a queue of them: a slow reader gets what is
  // true now, not a history of what was.
  const pending = new Map<number, unknown>()
  // Which cell each watch is on, so a complaint can name it.
  const named = new Map<number, string>()
  let flushing = false

  function flush(): void {
    flushing = false
    if (pending.size === 0) return
    const changed = [...pending].map(([id, value]) => ({ id, value }))
    pending.clear()
    try {
      channel.send({ kind: 'values', changed })
    } catch {
      // One value that will not clone must not cost the others theirs: send them
      // one at a time and complain only about those that really fail.
      for (const one of changed) sendAlone(one)
    }
  }

  function sendAlone(one: { id: number; value: unknown }): void {
    try {
      channel.send({ kind: 'values', changed: [one] })
    } catch (error) {
      complain(one.id, error)
    }
  }

  function complain(id: number, error: unknown): void {
    options.onUnsendable?.(named.get(id) ?? String(id), error)
  }

  function later(): void {
    if (flushing) return
    flushing = true
    schedule(flush)
  }

  function cellOf(name: string, key: unknown): Watchable<unknown> | undefined {
    const plain = surface.cells?.[name]
    if (plain !== undefined) return plain
    const keyed = surface.families?.[name]
    return keyed === undefined ? undefined : keyed(key as never)
  }

  function onWatch(message: Extract<ToGraph, { kind: 'watch' }>): void {
    if (watching.has(message.id)) return
    const cell = cellOf(message.cell, message.key)
    if (cell === undefined) {
      channel.send({ kind: 'failed', id: message.id, error: `no cell "${message.cell}"` })
      return
    }
    const stop = subscribe(cell, value => {
      pending.set(message.id, value)
      later()
    })
    watching.set(message.id, stop)
    named.set(message.id, message.cell)
    // The first value goes at once: a screen should not wait a frame to show.
    pending.set(
      message.id,
      untracked(() => cell.get()),
    )
    later()
  }

  async function onCall(message: Extract<ToGraph, { kind: 'call' }>): Promise<void> {
    const command = surface.commands?.[message.command]
    if (command === undefined) {
      channel.send({ kind: 'failed', id: message.id, error: `no command "${message.command}"` })
      return
    }
    try {
      const value = await (command as (...args: unknown[]) => unknown)(...message.args)
      channel.send({ kind: 'done', id: message.id, value })
    } catch (error) {
      channel.send({
        kind: 'failed',
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const stopListening = channel.listen(raw => {
    const message = raw as ToGraph
    switch (message?.kind) {
      case 'watch':
        onWatch(message)
        return
      case 'unwatch': {
        watching.get(message.id)?.()
        watching.delete(message.id)
        pending.delete(message.id)
        named.delete(message.id)
        return
      }
      case 'call':
        void onCall(message)
        return
      case 'write': {
        surface.facts?.[message.fact]?.set(message.value as never)
        return
      }
      default:
        return
    }
  })

  // Say we are here: a watcher that outlived the last graph must ask again.
  channel.send({ kind: 'up' })

  return () => {
    stopListening()
    for (const stop of watching.values()) stop()
    watching.clear()
    pending.clear()
    named.clear()
  }
}
