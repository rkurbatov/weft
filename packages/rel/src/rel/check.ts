// What a tree must not do, said before it runs. A projection that drops or
// recomputes a key field, a fold named after a grouping field, a union whose
// sides are keyed differently — all of it is caught at build time, where the
// message can still name the mistake.

/** Build errors are caught before anything runs; the message names the node. */

import type { RelNode } from './shape.ts'
import { keyPaths } from './keys.ts'

export function checkNode(node: RelNode): void {
  switch (node.prim) {
    case 'source':
      if (node.key.length === 0) throw new Error(`weft rel: source ${node.source} declares no key`)
      return
    case 'filter':
      checkNode(node.input)
      return
    case 'pure': {
      checkNode(node.input)
      const heads = new Set(keyPaths(node).map(p => p[0] as string))
      if (node.fields !== undefined) {
        for (const name of Object.keys(node.fields)) {
          if (heads.has(name)) {
            throw new Error(
              `weft rel: pure recomputes key field '${name}' — that is a new identity, not an edit`,
            )
          }
        }
      }
      if (node.pick !== undefined) {
        for (const head of heads) {
          if (!node.pick.includes(head)) {
            throw new Error(
              `weft rel: pure picks away key field '${head}' — a row would lose its identity`,
            )
          }
        }
      }
      return
    }
    case 'join': {
      checkNode(node.left)
      checkNode(node.right)
      if (node.on.length === 0) throw new Error('weft rel: join declares no on-keys')
      if (node.as.length === 0) throw new Error('weft rel: join declares no alias')
      return
    }
    case 'scan': {
      checkNode(node.input)
      if (node.order.length === 0) throw new Error('weft rel: scan declares no order')
      for (const path of keyPaths(node)) {
        const head = path[0] as string
        if (head === node.as || head === node.through) {
          throw new Error(`weft rel: scan writes over key field '${head}'`)
        }
      }
      return
    }
    case 'union': {
      checkNode(node.left)
      checkNode(node.right)
      const left = JSON.stringify(keyPaths(node.left))
      const right = JSON.stringify(keyPaths(node.right))
      if (left !== right) {
        throw new Error(`weft rel: union sides key differently — ${left} against ${right}`)
      }
      return
    }
    case 'expand': {
      checkNode(node.input)
      if (node.field.length === 0) throw new Error('weft rel: expand names no field')
      if (node.as.length === 0) throw new Error('weft rel: expand declares no alias')
      if (node.key.length === 0) throw new Error('weft rel: expand declares no nested key')
      return
    }
    case 'agg': {
      checkNode(node.input)
      if (Object.keys(node.folds).length === 0) throw new Error('weft rel: agg declares no folds')
      for (const name of Object.keys(node.folds)) {
        if (node.by.includes(name)) {
          throw new Error(`weft rel: agg fold '${name}' collides with a by-field of the same name`)
        }
      }
      return
    }
  }
}
