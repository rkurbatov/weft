// The engine seam's render lane: the hooks under a real DOM and React's act,
// on the same node:test runner as everything else. What is tested here is the
// seam law: demand flows through the tree, gating reaches it, a suspended cold
// start asks the world exactly once — StrictMode's double render included.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { Component, StrictMode, Suspense, act, createElement as h, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { input } from '#weft'
import { source } from '#weft'
import { useCell, useInputBinding, useKeepRow, useSourceValue } from '#weft-react'
import { wait } from '../kit/index.ts'

const { createRoot } = await import('react-dom/client')
type Root = ReturnType<typeof createRoot>

describe('the React seam, rendered', () => {
  function mount(node: ReactNode): { el: HTMLElement; unmount: () => void } {
    const el = document.createElement('div')
    document.body.append(el)
    let root: Root
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

  class Boundary extends Component<{ children: ReactNode }, { trouble: unknown }> {
    override state = { trouble: null as unknown }
    static getDerivedStateFromError(trouble: unknown): { trouble: unknown } {
      return { trouble }
    }
    override render(): ReactNode {
      return this.state.trouble === null
        ? this.props.children
        : h('em', null, String(this.state.trouble))
    }
  }

  test('useCell: the value renders, gating reaches the tree, demand leaves with the screen', () => {
    const life: string[] = []
    const field = input(1, {
      name: 'n',
      onDemand: () => life.push('on'),
      onIdle: () => life.push('off'),
    })
    let renders = 0
    function View(): ReactNode {
      renders++
      return h('span', null, String(useCell(field)))
    }

    const shown = mount(h(View))
    assert.equal(shown.el.textContent, '1')
    assert.deepEqual(life, ['on']) // mounting is the demand

    act(() => field.set(2))
    assert.equal(shown.el.textContent, '2')
    const was = renders

    act(() => field.set(2)) // not a change: the wave dies before the tree
    assert.equal(renders, was)

    shown.unmount()
    assert.deepEqual(life, ['on', 'off']) // and leaves with the screen
  })

  test('useInputBinding: keystrokes land in the input, the input lands in the field', () => {
    const title = input('', { name: 'title' })
    function Field(): ReactNode {
      return h('input', { ...useInputBinding(title) })
    }
    const shown = mount(h(Field))
    const box = shown.el.querySelector('input')
    assert.ok(box !== null)

    act(() => {
      // React puts a value tracker on the field; going through the prototype's
      // own setter is what makes the event look like a real keystroke.
      const proto = Object.getPrototypeOf(box) as object
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(box, 'hello')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    assert.equal(title.peek(), 'hello')

    act(() => title.set('from outside'))
    assert.equal(box.value, 'from outside')
    shown.unmount()
  })

  test('useSourceValue: a cold start suspends and asks once — under StrictMode', async () => {
    let asked = 0
    const feed = source(
      () => {
        asked++
        return new Promise<string>(resolve => setTimeout(() => resolve('answer'), 15))
      },
      { name: 'feed' },
    )
    function Shows(): ReactNode {
      return h('b', null, useSourceValue(feed))
    }
    const shown = mount(
      h(StrictMode, null, h(Suspense, { fallback: h('i', null, 'wait') }, h(Shows))),
    )
    assert.equal(shown.el.textContent, 'wait')

    await act(async () => {
      await wait(40)
    })
    assert.equal(shown.el.textContent, 'answer')
    assert.equal(asked, 1) // the double render shared one arrival

    // Stale shows while the fresh travels: a refresh does not re-suspend.
    await act(async () => {
      void feed.refresh()
    })
    assert.equal(shown.el.textContent, 'answer')
    await act(async () => {
      await wait(40)
    })
    assert.equal(asked, 2)
    assert.equal(shown.el.textContent, 'answer')
    shown.unmount()
  })

  test('useSourceValue: a refusal with empty hands lands in the boundary', async () => {
    const sour = source(() => Promise.reject(new Error('the world is down')), { name: 'sour' })
    function Shows(): ReactNode {
      return h('b', null, useSourceValue(sour))
    }
    const shown = mount(
      h(Boundary, null, h(Suspense, { fallback: h('i', null, 'wait') }, h(Shows))),
    )
    assert.equal(shown.el.textContent, 'wait')
    await act(async () => {
      await wait(20)
    })
    assert.match(shown.el.textContent ?? '', /the world is down/)
    shown.unmount()
  })

  test('useKeepRow: the row under the reader stays put while the list moves', () => {
    // The reader is looking at row `watched`, drawn at index 5 with 20px rows.
    // Three rows are then born above it, so the view says it stands at 8 — the
    // hook must scroll by the same three rows, or the screen jumps.
    let rank = 5
    let redraw = (): void => {}

    function List(): ReactNode {
      const el = useRef<HTMLDivElement>(null)
      const [, bump] = useState(0)
      redraw = () => bump(n => n + 1)
      useKeepRow({
        box: el,
        rowHeight: 20,
        first: 5,
        rows: [{ id: 'watched' }],
        keyOf: (row: { id: string }) => row.id,
        rankOf: () => rank,
      })
      return h('div', { ref: el }, 'watched')
    }

    const view = mount(h(List))
    const el = view.el.firstChild as HTMLElement
    el.scrollTop = 100

    rank = 8
    act(() => redraw())
    assert.equal(el.scrollTop, 160) // three rows of 20, and not a pixel more

    // Standing still costs nothing: no rank change, no scrolling.
    act(() => redraw())
    assert.equal(el.scrollTop, 160)
    view.unmount()
  })
})
