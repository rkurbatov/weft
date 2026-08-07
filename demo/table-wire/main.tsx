// Where the table lives is one decision, made here. The panel above reads the
// station out of a cell, so replacing it is seen like any other change.

import { adopt, cell, overWire } from '#loom'
import type { Adopted, Port } from '#loom'
import { mount } from '#demo/mount.tsx'
import { App } from './App.tsx'
import type { Task } from './state.ts'
import './desk.css'

/** What the panel uses: the station's views, facts and acts, named. */
export interface Desk {
  readonly size: { get(): number | undefined }
  readonly from: { get(): number | undefined; set(value: number): void }
  readonly span: { get(): number | undefined; set(value: number): void }
  readonly window: { get(): readonly Task[] | undefined }
  readonly crossed: { get(): number | undefined }
  readonly draft: (key: number) => { get(): string; set(value: string): void }
  readonly rename: (id: number, title: string) => Promise<void>
}

function start(): Desk {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  const station: Adopted = adopt(overWire(worker))

  // Drafts live here, on the panel's side: they are this tab's unfinished
  // typing, not the table's data, and they must outlive a row scrolling away.
  const drafts = new Map<number, Port<string>>()
  const draft = (key: number): Port<string> => {
    const known = drafts.get(key)
    if (known !== undefined) return known
    const made = cell('', { name: `draft.${String(key)}` })
    drafts.set(key, made)
    return made
  }

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
    window: station.view<readonly Task[]>('window'),
    crossed: station.view<number>('crossed'),
    draft,
    rename: station.act<[number, string]>('rename'),
  }
}

// Module state, not effect state: the world outlives a tab's renders.
export const desk = cell(start(), { name: 'desk' })

mount(<App />)
