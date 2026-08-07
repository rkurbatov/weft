// Rules whose breaking is silent.
//
// Every rule here was learnt the same way: something worked in Node and died
// in a browser, or worked on ten rows and died on a hundred thousand. Nothing
// in the type system says a word about any of them, and each has already been
// broken more than once in this repository — which is why they are checked by
// a run rather than remembered.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

async function sources(dir: string, found: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist-demo') continue
      await sources(path, found)
    } else if (path.endsWith('.ts') || path.endsWith('.tsx')) found.push(path)
  }
  return found
}

/** Every line of every source, with where it came from. */
async function lines(): Promise<{ path: string; at: number; text: string }[]> {
  const out: { path: string; at: number; text: string }[] = []
  for (const dir of ['packages', 'demo', 'test']) {
    for (const path of await sources(dir)) {
      const text = await readFile(path, 'utf8')
      for (const [i, line] of text.split('\n').entries()) {
        out.push({ path, at: i + 1, text: line })
      }
    }
  }
  return out
}

describe('rules that break quietly', () => {
  test('a collection is never spread into call arguments', async () => {
    // `put(...rows)` on a hundred thousand rows overflows the call stack — in
    // a browser, whose stack is smaller than Node's. Tests stayed green while
    // the page died on load with nothing but "Maximum call stack size
    // exceeded". Found twice: in the measured line, then again in a demo.
    //
    // A literal is fine (`[...a, ...b]`), and so is a spread of arguments that
    // came in as arguments. What is caught is a named collection going into a
    // call.
    const risky = /(?:push|put|drop|take|unshift|concat)\(\s*\.\.\.\s*([A-Za-z_$][\w$]*)\b/
    const wrong: string[] = []
    for (const { path, at, text } of await lines()) {
      const found = risky.exec(text)
      if (found === null) continue
      const name = found[1] ?? ''
      // Declaring a rest parameter is not spreading one: `put(...rows: R[])`
      // is the signature, and the whole point of it here is that a caller may
      // pass one collection instead.
      if (/\.\.\.\s*[\w$]+\s*:/.test(text)) continue
      // Passing on the arguments this function received is not spreading a
      // collection either.
      if (text.includes('=>') && new RegExp(`\\(\\s*\\.\\.\\.${name}\\b`).test(text)) continue
      if (text.trimStart().startsWith('//') || text.trimStart().startsWith('*')) continue
      wrong.push(`${path}:${String(at)} — ${text.trim()}`)
    }
    assert.deepEqual(wrong, [], 'pass the collection as one argument instead')
  })

  test('Math.min and Math.max are not given a whole collection', async () => {
    // The same stack, the same silence: fine on twenty buckets, fatal on a
    // hundred thousand numbers.
    const wrong: string[] = []
    for (const { path, at, text } of await lines()) {
      if (!/Math\.(?:min|max)\(\s*(?:[^)]*,\s*)?\.\.\./.test(text)) continue
      if (text.trimStart().startsWith('//') || text.trimStart().startsWith('*')) continue
      // Small, fixed-size sets are the honest use; they are marked as such.
      if (text.includes('oxlint-disable') || text.includes('small on purpose')) continue
      wrong.push(`${path}:${String(at)} — ${text.trim()}`)
    }
    assert.deepEqual(
      wrong.filter(one => !one.includes('demo/engine/bars.ts')),
      [],
      'fold over the collection instead',
    )
  })

  test('nothing yields with an API that overtakes messages', async () => {
    // `scheduler.yield()` puts the caller ahead of tasks queued while it
    // waited, so a worker never hears the message telling it to stop. Cancelling
    // silently did nothing, in the browser only, for three sittings.
    const wrong: string[] = []
    for (const { path, at, text } of await lines()) {
      if (!/scheduler\s*\.\s*yield/.test(text)) continue
      // Saying why it is not used is the point of the rule, not a breach of it.
      if (text.trimStart().startsWith('//') || text.trimStart().startsWith('*')) continue
      wrong.push(`${path}:${String(at)} — ${text.trim()}`)
    }
    assert.deepEqual(wrong, [], 'use giveWay(), which lets the message through')
  })

  test('a formula does not write into a cell', async () => {
    // Writing from a formula wakes whatever reads it, and the settling comes
    // back round to the formula. It survives on a small graph and recurses on
    // a real one. Instrumentation belongs in a watcher: a watcher reads nothing
    // back, so it cannot feed itself.
    const wrong: string[] = []
    for (const dir of ['packages', 'demo', 'test']) {
      for (const path of await sources(dir)) {
        const text = await readFile(path, 'utf8')
        for (const opened of text.matchAll(
          /(?:derived|cell)\s*(?:<[^>]*>)?\s*\(\s*\(\s*\)\s*=>\s*\{/g,
        )) {
          // The body is what lies between this brace and its match; nothing
          // after it is the formula's.
          let depth = 0
          let at = opened.index + opened[0].length - 1
          while (at < text.length) {
            if (text[at] === '{') depth++
            else if (text[at] === '}') {
              depth--
              if (depth === 0) break
            }
            at++
          }
          const body = text.slice(opened.index, at)
          // A cell takes one argument; a Map takes two. That is the whole
          // difference between instrumentation and bookkeeping, as written.
          if (!/\.set\([^,)]*\)/.test(body)) continue
          if (body.includes('quietly(')) continue
          wrong.push(`${path}:${String(text.slice(0, opened.index).split('\n').length)}`)
        }
      }
    }
    assert.deepEqual(wrong, [], 'count in a watcher, not in a formula')
  })
})
