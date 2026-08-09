// Where the table lives is one decision, made here. The panel above reads the
// station out of a cell, so replacing it is seen like any other change.

import { cell, loom, worker } from '#loom'
import type { Loomed, Port } from '#loom'
import { mount } from '#demo/mount.tsx'
import { App } from './App.tsx'
import type { Task } from './state.ts'
import './desk.css'

/** What the panel uses: the station's views, facts and acts, named. */
export interface Desk {
  readonly size: { get(): number | undefined }
  readonly from: { get(): number | undefined; set(value: number): void }
  readonly span: { get(): number | undefined; set(value: number): void }
  readonly window: { rows: { get(): readonly Task[] } }
  /** Rows that actually arrived over the wire — counted where they land. */
  readonly received: { get(): number }
  /** What the graph on the other side is doing, counted by the library. */
  readonly recomputed: { get(): number | undefined }
  readonly woken: { get(): number | undefined }
  readonly draft: (key: number) => { get(): string; set(value: string): void }
  readonly rename: (id: number, title: string) => Promise<void>
}

function start(): Desk {
  // One line for the whole arrangement: the station lives in the worker, this
  // side is a window onto it.
  const station: Loomed = loom(
    { name: 'desk' },
    { wire: worker(new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })) },
  )

  // Drafts live here, on the panel's side: they are this tab's unfinished
  // typing, not the table's data, and they must outlive a row scrolling away.
  //
  // Synchronous on purpose, and that is the second reason. A controlled input
  // whose value travels to a worker and back moves the caret: the keystroke
  // renders one value, the answer arrives a frame later with another, and
  // React puts the cursor at the end of the text. Closing the render loop on
  // this side means the field always shows exactly what was typed; the commit
  // to the table crosses the wire in its own time.
  const drafts = new Map<number, Port<string>>()
  const draft = (key: number): Port<string> => {
    const known = drafts.get(key)
    if (known !== undefined) return known
    const made = cell('', { name: `draft.${String(key)}` })
    drafts.set(key, made)
    return made
  }

  const mirror = station.list<Task>('window')

  return {
    size: station.view<number>('size'),
    from: {
      get: () => station.view<number>('from').get(),
      set: value => station.write('from', value),
    },
    span: {
      get: () => station.view<number>('span').get(),
      set: value => station.write('span', value),
    },
    // Followed, not watched: the window arrives as differences, so scrolling
    // by one row costs one row on the wire.
    window: mirror,
    received: mirror.received,
    recomputed: station.view<number>('recomputed'),
    woken: station.view<number>('woken'),

    draft,
    rename: station.act<[number, string]>('rename'),
  }
}

// Module state, not effect state: the world outlives a tab's renders.
export const desk = cell(start(), { name: 'desk' })

mount(<App />)
