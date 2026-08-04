// The cross-implementation corpus: one scenario file, two engines. Each file
// is pure data — a tree, a sequence of source patches, and the expected rows
// after every step, frozen by the oracle. This runner holds the TypeScript
// side to them twice over: the live delta path and the naive recount must
// both land on the frozen answer, at every step. The Go implementation reads
// the same files; a disagreement is closed by fixing an engine or by adding
// a line to the corpus — never by loosening a check.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { test } from 'node:test'
import { subscribe, table } from '#weft'
import type { Key, SourceTable } from '#weft'
import { keyOfRow, recount } from '#weft/rel/node.ts'
import type { RelNode, SourceNode } from '#weft/rel/node.ts'
import { relate } from '#weft/rel/live.ts'
import type { Row } from '#weft/rel/expr.ts'

interface Scenario {
  name: string
  tree: RelNode
  steps: Array<{
    source: string
    put?: Row[]
    drop?: Key[]
    expect: Row[]
  }>
}

function sourceDecls(
  node: RelNode,
  out: Map<string, SourceNode> = new Map(),
): Map<string, SourceNode> {
  switch (node.prim) {
    case 'source':
      out.set(node.source, node)
      return out
    case 'filter':
    case 'pure':
      return sourceDecls(node.input, out)
    case 'join':
      sourceDecls(node.left, out)
      return sourceDecls(node.right, out)
  }
}

const here = joinPath(import.meta.dirname, 'corpus')

for (const file of readdirSync(here).toSorted()) {
  if (!file.endsWith('.json')) continue
  const scenario = JSON.parse(readFileSync(joinPath(here, file), 'utf8')) as Scenario

  test(`corpus ${scenario.name}: the live path and the recount both land on the frozen answer`, () => {
    const decls = sourceDecls(scenario.tree)
    const tables: Record<string, SourceTable<Row>> = {}
    const held: Record<string, Map<Key, Row>> = {}
    for (const [name, node] of decls) {
      tables[name] = table<Row>({ key: row => keyOfRow(node, row), name })
      held[name] = new Map()
    }
    const live = relate(scenario.tree, tables)
    const stop = subscribe(live.all, () => {})

    for (const [at, step] of scenario.steps.entries()) {
      const feed = tables[step.source]
      const node = decls.get(step.source)
      assert.ok(feed !== undefined && node !== undefined, `unknown source '${step.source}'`)
      feed.apply({
        ...(step.put ? { put: step.put } : {}),
        ...(step.drop ? { drop: step.drop } : {}),
      })
      const rows = held[step.source] as Map<Key, Row>
      for (const row of step.put ?? []) rows.set(keyOfRow(node, row), row)
      for (const key of step.drop ?? []) rows.delete(key)

      const want = new Map<Key, Row>()
      for (const row of step.expect) want.set(keyOfRow(scenario.tree, row), row)

      const got = live.all.peek()
      assert.equal(got.length, want.size, `${scenario.name} step ${at}: live size`)
      for (const row of got) {
        assert.deepEqual(
          row,
          want.get(keyOfRow(scenario.tree, row)),
          `${scenario.name} step ${at}: live row`,
        )
      }

      const counted = recount(scenario.tree, held)
      assert.equal(counted.size, want.size, `${scenario.name} step ${at}: recount size`)
      for (const [key, row] of counted) {
        assert.deepEqual(row, want.get(key), `${scenario.name} step ${at}: recount row`)
      }
    }
    stop()
    live.dispose()
    for (const t of Object.values(tables)) t.dispose()
  })
}
