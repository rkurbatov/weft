// The packages, and what each of them may know.
//
// The tree is already laid out the way it would be published: one folder per
// package, each with its own surface in `index.ts`. Nothing is published yet —
// splitting into separate releases costs an ordering ritual on every change,
// and the engine still changes weekly. But the shape is real, so that the day
// it becomes worth it, the move is a rename and not a rewrite.
//
// Two rules, both checked here rather than promised. A package reaches only
// downwards, and it reaches a neighbour by alias — never by a relative path
// across the border, because such a path is exactly what would break on the
// day of the split.

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'

/** Bottom first: a package may use the ones before it, never the ones after. */
const stack = [
  'data', // keys, structural sharing, backoff, the notice channel
  'graph', // cells, engines, regions, ticks, the journal
  'line', // a measured line: offsets along it, answers over ranges of it
  'remote', // the shape of an answer from elsewhere, sources, queries, reconciling
  'table', // rows with a key, live views, folds, carriers and the planner
  'rel', // the relational layer: trees as data, runners, the builder
  'keep', // disk, kept values, the outbox, its lanes and the projection over it
  'link', // transport, addressing, the tab protocol, serving and mirroring
  'weft', // the front door: everything above, in one import
  'loom', // the dialect
] as const

type Package = (typeof stack)[number]

const rank = new Map<Package, number>(stack.map((name, i) => [name, i]))

/**
 * Which package a file belongs to. The test kit is deliberately outside the
 * order: it is used by the tests of every package and used by no source, so it
 * has no place in a stack that talks about what may depend on what.
 */
function owner(path: string): Package | undefined {
  const name = path.split('/')[1] as Package
  return rank.has(name) ? name : undefined
}

/** Which package an import names, if it names one at all. */
function named(spec: string): Package | undefined {
  const alias = /^#(\w+)/.exec(spec)?.[1]
  return alias !== undefined && rank.has(alias as Package) ? (alias as Package) : undefined
}

async function sources(dir: string, found: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await sources(path, found)
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) found.push(path)
  }
  return found
}

/** The same walk, but for tests: they have rules of their own. */
async function testFiles(dir: string, found: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await testFiles(path, found)
    else if (path.endsWith('.test.ts')) found.push(path)
  }
  return found
}

/** Aliases a package offers besides its main door, taken from package.json. */
async function extraDoors(): Promise<Set<string>> {
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
    imports: Record<string, string>
  }
  return new Set(
    Object.keys(manifest.imports).filter(name => name.includes('/') && !name.endsWith('*')),
  )
}

interface Reach {
  from: string
  mine: Package
  spec: string
}

async function reaches(): Promise<Reach[]> {
  const found: Reach[] = []
  for (const path of await sources('packages')) {
    const mine = owner(path)
    if (mine === undefined) continue
    const text = await readFile(path, 'utf8')
    for (const match of text.matchAll(/from '([^']+)'/g)) {
      found.push({ from: path, mine, spec: match[1] ?? '' })
    }
  }
  return found
}

describe('the packages', () => {
  test('each reaches downwards only', async () => {
    const wrong = (await reaches()).filter(reach => {
      const theirs = named(reach.spec)
      if (theirs === undefined || theirs === reach.mine) return false
      return (rank.get(theirs) ?? 0) > (rank.get(reach.mine) ?? 0)
    })
    assert.deepEqual(
      wrong.map(r => `${r.from} (${r.mine}) -> ${r.spec}`),
      [],
      'a package reached upwards: either the import is wrong, or the order above is',
    )
  })

  test('a neighbour is reached by alias, never by a path across the border', async () => {
    const crossing = (await reaches()).filter(reach => {
      if (!reach.spec.startsWith('.')) return false
      const parts = reach.from.split('/').slice(0, -1)
      for (const step of reach.spec.split('/')) {
        if (step === '.') continue
        else if (step === '..') parts.pop()
        else parts.push(step)
      }
      const theirs = owner(parts.join('/'))
      return theirs !== undefined && theirs !== reach.mine
    })
    assert.deepEqual(
      crossing.map(r => `${r.from} -> ${r.spec}`),
      [],
      'use the alias: this path would not survive the split',
    )
  })

  test('nothing below the door goes through it', async () => {
    // The door is for the outside. A package reaching for '#weft' to get at a
    // neighbour hides which package it really depends on — and would make a
    // cycle the day the packages become real.
    const throughTheDoor = (await reaches()).filter(
      reach => reach.spec === '#weft' && (rank.get(reach.mine) ?? 0) < (rank.get('weft') ?? 0),
    )
    assert.deepEqual(
      throughTheDoor.map(r => r.from),
      [],
      'reach the package directly instead',
    )
  })

  test('every package has a surface of its own', async () => {
    for (const name of stack) {
      const index = await readFile(`packages/${name}/src/index.ts`, 'utf8').catch(() => '')
      assert.ok(index.includes('export'), `${name} has no surface`)
    }
  })

  test('a package test may look inside its own package, never inside another', async () => {
    // Tests live with what they test, and a test of a package is allowed the
    // inside of that package — thresholds, internal types, the halves a door
    // hides on purpose. What it may not do is reach into a neighbour: for a
    // neighbour there is a door, and if the door is not enough, the door is
    // wrong.
    const wrong: string[] = []
    const doors = await extraDoors()
    for (const path of await testFiles('packages')) {
      const mine = owner(path)
      const text = await readFile(path, 'utf8')
      for (const match of text.matchAll(/from '(#(\w+)\/[^']+)'/g)) {
        const spec = match[1] ?? ''
        if (match[2] === mine || doors.has(spec)) continue
        wrong.push(`${path} -> ${spec}`)
      }
    }
    assert.deepEqual(wrong, [], 'reach the neighbour by its door')
  })
})
