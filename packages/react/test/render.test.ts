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
import { port } from '#weft'
import { source } from '#weft'
import { useCell, useInputBinding, useKeepRow, useSourceValue } from '#react'
import { useLive } from '#loom/react'
import { wait } from '#testkit'

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

  // React reports a caught error through `console.error`, so a test that wants
  // a boundary to catch something prints a stack that looks like a failure and
  // is not one. Where that happens it is silenced by hand, and the silencing is
  // counted: a boundary that never fired must not pass for a working one.
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
    const field = port(1, {
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
    const title = port('', { name: 'title' })
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

  test('useSourceValue: a refusal with empty hands lands in the boundary once patience runs out', async () => {
    const sour = source(() => Promise.reject(new Error('the world is down')), {
      name: 'sour',
      retry: 1,
    })
    function Shows(): ReactNode {
      // No patience asked for: the first refusal is the answer.
      return h('b', null, useSourceValue(sour, { patience: 0 }))
    }
    const shown = mount(
      h(Boundary, null, h(Suspense, { fallback: h('i', null, 'wait') }, h(Shows))),
    )
    assert.equal(shown.el.textContent, 'wait')
    // React's own report of a caught error is not this test's output.
    const before = console.error
    let complained = 0
    console.error = () => {
      complained++
    }
    try {
      await act(async () => {
        await wait(20)
      })
    } finally {
      console.error = before
    }
    assert.match(shown.el.textContent ?? '', /the world is down/)
    assert.ok(complained > 0, 'the boundary really caught it, rather than nothing happening')
    shown.unmount()
  })

  test('useSourceValue: a refusal that will be tried again keeps waiting, and the retry shows', async () => {
    let up = false
    const flaky = source(
      () => (up ? Promise.resolve('here') : Promise.reject(new Error('down for now'))),
      { name: 'flaky', retry: 5 },
    )
    function Shows(): ReactNode {
      return h('b', null, useSourceValue(flaky))
    }
    const shown = mount(
      h(Boundary, null, h(Suspense, { fallback: h('i', null, 'wait') }, h(Shows))),
    )

    await act(async () => {
      await wait(20)
    })
    // The old behaviour painted the boundary here, and no later success could
    // take it down.
    assert.equal(shown.el.textContent, 'wait')

    up = true
    await act(async () => {
      await wait(60)
    })
    assert.equal(shown.el.textContent, 'here')
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

  test('a render that never commits leaves nothing behind in the graph', async () => {
    // A tree that suspends: React renders the child, throws the render away,
    // waits for the promise, then renders it again. The first, abandoned
    // render must not leave a screen cell watching the input forever.
    const seats = port(3, { name: 'seats' })
    let settle = (): void => {}
    const arrival = new Promise<void>(resolve => {
      settle = resolve
    })
    let arrived = false

    function Child(): ReactNode {
      const shown = useLive(() => seats.get())
      if (!arrived) throw arrival
      return h('span', null, String(shown))
    }

    const held = mount(h(Suspense, { fallback: h('span', null, 'waiting') }, h(Child, null)))
    assert.equal(seats.observers.size, 0, 'nothing watches while the render is thrown away')

    arrived = true
    settle()
    await act(async () => {
      await arrival
    })
    assert.equal(seats.observers.size, 1, 'the committed render watches, once')

    held.unmount()
    assert.equal(seats.observers.size, 0, 'and lets go on the way out')
  })
})
