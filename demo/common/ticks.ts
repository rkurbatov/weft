// The ticks instrument. Not a tail anymore: filter by node, open a tick to
// its writes and costs, click any name to follow it — the newest matching
// tick is the answer to "why did this change last" — and, for nodes handed
// in through `inspect`, a live trace: what it reads, who reads it, how
// current its value is. Plain createElement so the same file runs under the
// render test lane, where JSX does not.

import { createElement as h, useEffect, useMemo, useReducer, useState } from 'react'
import type { ReactNode } from 'react'
import { onNotice } from '#weft'
import type { Notice } from '#weft'
import { journal, trace } from '#weft'
import type { Trace, TickSummary, Watchable } from '#weft'

export type Inspectable = Watchable<unknown> & { readonly name?: string }

const short = (value: unknown): string => {
  try {
    const text = JSON.stringify(value) ?? String(value)
    return text.length > 48 ? `${text.slice(0, 45)}…` : text
  } catch {
    return String(value)
  }
}

function touched(tick: TickSummary, needle: string): boolean {
  if (needle === '') return true
  const has = (name: string): boolean => name.includes(needle)
  return (
    tick.writes.some(w => has(w.node)) ||
    tick.computed.some(c => has(c.node)) ||
    tick.gated.some(has)
  )
}

function TraceView({ look, depth = 0 }: { look: Trace; depth?: number }): ReactNode {
  return h(
    'div',
    { className: 'trace', style: { paddingLeft: depth * 14 } },
    h('b', null, look.name),
    ` ${look.state} = ${short(look.value)}`,
    look.readBy.length > 0 && h('span', { className: 'dim' }, ` ← ${look.readBy.join(', ')}`),
    ...(look.reads ?? []).map(read =>
      h(TraceView, { key: `${read.name}-${depth}`, look: read, depth: depth + 1 }),
    ),
  )
}

const noticeRow = (what: Notice, i: number): ReactNode =>
  h(
    'div',
    { key: `${what.kind}-${what.where}-${i}`, className: what.level === 'warn' ? 'warn' : 'dim' },
    h('b', null, what.kind),
    ' ',
    what.message,
  )

export function TicksPanel({
  limit = 30,
  inspect = [],
}: {
  limit?: number
  inspect?: readonly Inspectable[]
}): ReactNode {
  const [, bump] = useReducer((x: number) => x + 1, 0)
  const [book] = useState(() => journal(128, () => bump()))
  const [live, setLive] = useState(true)
  const [filter, setFilter] = useState('')
  const [opened, setOpened] = useState<number | null>(null)
  const [probed, setProbed] = useState<string | null>(null)
  // What the library noticed on its own: which carrier a fold got, a collection
  // too large to keep piece by piece, a join with a crowd under one key. The
  // channel had no listener until this panel; now it has one.
  const [noticed, setNoticed] = useState<readonly Notice[]>([])
  useEffect(
    () =>
      onNotice(what => {
        setNoticed(seen => [what, ...seen].slice(0, 40))
      }),
    [],
  )

  useEffect(() => {
    if (live) book.start()
    else book.stop()
    return () => book.stop()
  }, [book, live])

  const nodes = useMemo(() => {
    const named = new Map<string, Inspectable>()
    for (const node of inspect) if (node.name !== undefined) named.set(node.name, node)
    return named
  }, [inspect])

  const follow = (name: string): void => {
    setFilter(name)
    setProbed(nodes.has(name) ? name : null)
  }

  const nodeRef = (name: string, className: string): ReactNode =>
    h(
      'button',
      {
        key: name,
        className,
        onClick: (event: { stopPropagation(): void }) => {
          event.stopPropagation()
          follow(name)
        },
      },
      name,
    )

  const tail = book
    .ticks()
    .filter(tick => touched(tick, filter))
    .slice(-limit)
    .toReversed()

  const probedNode = probed === null ? undefined : nodes.get(probed)

  return h(
    'aside',
    { className: 'ticks' },
    h(
      'header',
      null,
      h('b', null, 'ticks'),
      h('input', {
        placeholder: 'filter by node',
        value: filter,
        onChange: (event: { target: { value: string } }) => setFilter(event.target.value),
      }),
      h('button', { onClick: () => setLive(was => !was) }, live ? 'pause' : 'record'),
      h(
        'button',
        {
          onClick: () => {
            book.clear()
            bump()
          },
        },
        'clear',
      ),
    ),
    probedNode !== undefined && h(TraceView, { look: trace(probedNode) }),
    tail.length === 0 && h('p', { className: 'dim' }, 'quiet — interact with the page'),
    ...tail.map(tick =>
      h(
        'div',
        {
          key: tick.id,
          className: 'tick',
          onClick: () => setOpened(was => (was === tick.id ? null : tick.id)),
        },
        h(
          'p',
          null,
          h('b', null, `#${tick.id}`),
          ' ',
          ...tick.writes.map(w => nodeRef(w.node, 'node')),
          ` → ${tick.computed.length}`,
          tick.gated.length > 0 &&
            h(
              'span',
              { className: 'gate' },
              ' ● ',
              ...tick.gated.map(g => nodeRef(g, 'node gate')),
            ),
          ` · woke ${tick.woke} · ${tick.ms.toFixed(1)}ms`,
        ),
        opened === tick.id &&
          h(
            'div',
            { className: 'detail' },
            ...tick.writes.map(w =>
              h('p', { key: `w-${w.node}` }, nodeRef(w.node, 'node'), ` ← ${short(w.value)}`),
            ),
            ...tick.computed.map((c, i) =>
              h(
                'p',
                { key: `c-${c.node}-${i}` },
                nodeRef(c.node, c.changed ? 'node' : 'node gate'),
                ` ${c.changed ? 'changed' : 'gated'} · ${c.ms.toFixed(2)}ms`,
              ),
            ),
          ),
      ),
    ),
    noticed.length > 0 &&
      h(
        'section',
        { className: 'notices' },
        h('header', null, h('b', null, 'noticed'), ` ${noticed.length}`),
        ...noticed.map(noticeRow),
      ),
  )
}
