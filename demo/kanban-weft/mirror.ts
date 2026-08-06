// The kanban across the wire: the station offers the domain's face, a tab
// adopts it and assembles the very same Kanban shape out of mirrors. The
// tests cannot tell which side of the boundary they run on — that is the
// whole point.

import { adopt, cell, offer } from '#loom'
import type { Refusal } from '#loom'
import type { OfferOptions } from '#loom'
import type { Channel, Watchable } from '#weft'
import type { Card, ColumnData } from '#kanban'
import type { Kanban } from './state.ts'

/** The station's side: what of the kanban goes on the wire. */
export function serveKanban(app: Kanban, channel: Channel, options: OfferOptions = {}): () => void {
  return offer(
    {
      views: {
        layout: app.state.layout,
        cards: app.state.cards,
        busy: app.state.busy,
        addBusy: app.state.addBusy,
        refused: app.state.refused,
        coldStart: app.state.coldStart,
        fault: app.state.fault,
        owed: app.post.owed,
      },
      acts: {
        move: (id: string, into: string, at: number) => app.actions.move(id, into, at),
        remove: (id: string) => app.actions.remove(id),
        add: (into: string, title: string, key?: string) => app.actions.add(into, title, key),
        load: () => app.actions.load(),
        pause: () => app.post.pause(),
        resume: () => app.post.resume(),
      },
    },
    channel,
    options,
  )
}

/** The tab's side: the same Kanban shape, every read a mirror. */
export function kanbanMirror(channel: Channel): Kanban {
  const tab = adopt(channel)

  const plain = <T>(name: string, empty: T): Watchable<T> => {
    const face = tab.view<T>(name)
    return cell(() => face.get() ?? empty, { name: `${name}.plain` })
  }

  const move = tab.act<[string, string, number]>('move')
  const remove = tab.act<[string]>('remove')
  const add = tab.act<[string, string, string | undefined]>('add')
  const load = tab.act<[]>('load')
  const pause = tab.act<[]>('pause')
  const resume = tab.act<[]>('resume')

  return {
    state: {
      layout: plain<ColumnData[]>('layout', []),
      cards: plain<ReadonlyMap<string, Card>>('cards', new Map()),
      busy: plain<ReadonlySet<string>>('busy', new Set()),
      addBusy: plain<string | null>('addBusy', null),
      refused: plain<Refusal | null>('refused', null),
      coldStart: plain<boolean>('coldStart', true),
      fault: plain<string | null>('fault', null),
    },
    actions: {
      move: (id, into, at) => move(id, into, at).catch(() => {}),
      remove: id => remove(id).catch(() => {}),
      add: (into, title, key) => add(into, title, key).catch(() => {}),
      load: () => load().catch(() => {}),
    },
    post: {
      pause: () => void pause().catch(() => {}),
      resume: () => void resume().catch(() => {}),
      owed: plain<number>('owed', 0),
    },
    dispose: () => tab.close(),
  }
}
