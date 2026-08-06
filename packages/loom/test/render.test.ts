// The dialect's render lane: useLive under a real DOM, React's act and
// StrictMode — the values keep flowing after the double mount, and a Map
// change is not gated away.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { StrictMode, act, createElement as h } from 'react'
import type { ReactNode } from 'react'
import { port } from '#weft'

const { createRoot } = await import('react-dom/client')
type Root = ReturnType<typeof createRoot>

describe('the dialect under a render', () => {
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

  test('useLive under StrictMode: values keep flowing after the double mount, Maps included', async () => {
    const { useLive } = await import('#loom/react')
    const rows = port<ReadonlyMap<string, number>>(new Map([['a', 1]]), { name: 'rows' })
    const label = port('cold', { name: 'label' })

    function Live(): ReactNode {
      const live = useLive(() => ({
        label: label.get(),
        total: [...rows.get().values()].reduce((s, n) => s + n, 0),
      }))
      return h('b', null, `${live.label}:${live.total}`)
    }

    const shown = mount(h(StrictMode, null, h(Live)))
    assert.equal(shown.el.textContent, 'cold:1')

    act(() => label.set('warm')) // after StrictMode's mount-unmount-mount
    assert.equal(shown.el.textContent, 'warm:1') // the screen did not freeze

    act(() =>
      rows.set(
        new Map([
          ['a', 1],
          ['b', 2],
        ]),
      ),
    ) // a Map change must not be gated
    assert.equal(shown.el.textContent, 'warm:3')
    shown.unmount()
  })
})
