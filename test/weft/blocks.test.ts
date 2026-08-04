// The blocks and what each of them is allowed to know.
//
// The library is not one bag: it is a stack of blocks, and each may reach only
// downwards. Written as a test rather than as a paragraph in a document,
// because a boundary nobody checks stops being a boundary — and the failure
// says exactly which import broke which rule.
//
// The order below is the whole architecture in one list. To move a block is to
// change this list first, on purpose, and only then the code.

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'

/** Bottom first: a block may know the blocks above it in this list, never below. */
const stack = [
  'data', // plain values: keys, structural sharing, arrangement. Knows nothing.
  'graph', // cells, engines, regions, waves, journal. Knows data.
  'remote', // the shape of an answer from elsewhere, sources, queries.
  'keep', // disk, kept values, the outbox, the projection over it.
  'table', // rows, views, folds, carriers and the planner that picks them.
  'rel', // the relational layer: nodes as data, runners, the builder.
  'link', // the wire: channels, serving, mirrors, buses, leadership.
  'door', // #weft: what the library offers the world.
  'react', // the seam with React: hooks over the door, and nothing else.
  'loom', // the dialect: the door plus the seam, said in the words of a task.
] as const

type Block = (typeof stack)[number]

const rank = new Map<Block, number>(stack.map((name, i) => [name, i]))

function blockOf(path: string): Block | undefined {
  if (path.startsWith('src/weft/core/')) {
    const name = path.split('/')[3] as Block
    return rank.has(name) ? name : undefined
  }
  if (path.startsWith('src/weft/rel/')) return 'rel'
  if (path.startsWith('src/weft/link/')) return 'link'
  if (path === 'src/weft/index.ts') return 'door'
  if (path.startsWith('src/loom/')) return 'loom'
  if (path.startsWith('src/weft-react/')) return 'react'
  return undefined
}

function targetBlock(from: string, spec: string): Block | undefined {
  if (spec.startsWith('#weft/core/'))
    return blockOf(`src/weft/core/${spec.slice('#weft/core/'.length)}`)
  if (spec.startsWith('#weft/rel')) return 'rel'
  if (spec.startsWith('#weft/link')) return 'link'
  if (spec === '#weft') return 'door'
  if (spec === '#weft-react') return 'react'
  if (spec.startsWith('#loom')) return 'loom'
  if (!spec.startsWith('.')) return undefined
  const parts = from.split('/').slice(0, -1)
  for (const step of spec.split('/')) {
    if (step === '.') continue
    else if (step === '..') parts.pop()
    else parts.push(step)
  }
  return blockOf(parts.join('/'))
}

async function sources(dir: string, found: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await sources(path, found)
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) found.push(path)
  }
  return found
}

interface Reach {
  from: string
  fromBlock: Block
  toBlock: Block
  spec: string
}

async function reaches(): Promise<Reach[]> {
  const found: Reach[] = []
  for (const path of await sources('src')) {
    const fromBlock = blockOf(path)
    if (fromBlock === undefined) continue
    const text = await readFile(path, 'utf8')
    for (const match of text.matchAll(/from '([^']+)'/g)) {
      const spec = match[1] ?? ''
      const toBlock = targetBlock(path, spec)
      if (toBlock === undefined || toBlock === fromBlock) continue
      found.push({ from: path, fromBlock, toBlock, spec })
    }
  }
  return found
}

describe('the blocks of the library', () => {
  test('every block reaches downwards only', async () => {
    const wrong = (await reaches()).filter(
      reach => (rank.get(reach.toBlock) ?? 0) > (rank.get(reach.fromBlock) ?? 0),
    )
    assert.deepEqual(
      wrong.map(r => `${r.from} (${r.fromBlock}) -> ${r.spec} (${r.toBlock})`),
      [],
      'a block reached upwards: either the import is wrong, or the stack above is',
    )
  })

  test('nothing inside the library goes through the front door', async () => {
    // The door is for the outside. A block that imports `#weft` to reach its
    // own neighbour makes a circle nobody can follow — and hides which block
    // it really depends on.
    const throughTheDoor = (await reaches()).filter(
      reach =>
        reach.toBlock === 'door' && reach.fromBlock !== 'loom' && reach.fromBlock !== 'react',
    )
    assert.deepEqual(
      throughTheDoor.map(r => `${r.from} -> ${r.spec}`),
      [],
      'reach the block directly instead',
    )
  })

  test('the stack is the one written in the framing document', () => {
    // If this list changes, the document changes with it in the same commit.
    assert.deepEqual(stack.length, 10)
    assert.equal(stack[0], 'data')
    assert.equal(stack.at(-1), 'loom')
  })
})
