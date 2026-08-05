// The waves instrument under the render lane: a tick shows up, the filter
// narrows, following a name shows its live trace.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { act, createElement as h } from 'react'
import type { ReactNode } from 'react'
import { derived, port, subscribe } from '#weft'
import { TicksPanel } from './ticks.ts'

const { createRoot } = await import('react-dom/client')

function mount(node: ReactNode): { el: HTMLElement; unmount: () => void } {
  const el = document.createElement('div')
  document.body.append(el)
  let root: ReturnType<typeof createRoot>
  act(() => {
    root = createRoot(el)
    root.render(node)
  })
  return {
    el,
    unmount: () => {
      act(() => root.unmount())
      el.remove()
    },
  }
}

function type(box: HTMLInputElement, text: string): void {
  const proto = Object.getPrototypeOf(box) as object
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(box, text)
  box.dispatchEvent(new Event('input', { bubbles: true }))
}

test('a tick shows up, the filter narrows, following a name opens its trace', () => {
  const price = port(1, { name: 'price' })
  const doubled = derived(() => price.get() * 2, { name: 'doubled' })
  const stop = subscribe(doubled, () => {})

  const shown = mount(h(TicksPanel, { inspect: [doubled] }))
  assert.match(shown.el.textContent ?? '', /quiet/)

  act(() => price.set(3))
  assert.match(shown.el.textContent ?? '', /price/)

  const row = shown.el.querySelector('.tick') as HTMLElement | null
  assert.ok(row !== null)
  act(() => row.click()) // open the tick: its recomputes and costs
  assert.match(shown.el.textContent ?? '', /doubled changed/)

  const box = shown.el.querySelector('input')
  assert.ok(box !== null)
  act(() => type(box, 'nothing-like-this'))
  assert.doesNotMatch(shown.el.textContent ?? '', /price/)
  act(() => type(box, 'pri'))
  assert.match(shown.el.textContent ?? '', /price/)

  // Following a node: the newest matching tick is "why it changed last",
  // and an inspected node shows its live trace.
  const name = [...shown.el.querySelectorAll('button')].find(b => b.textContent === 'doubled')
  assert.ok(name !== undefined)
  act(() => name.click())
  assert.match(shown.el.textContent ?? '', /doubled clean = 6/)
  assert.match(shown.el.textContent ?? '', /← \(watcher\)/)

  stop()
  shown.unmount()
})
