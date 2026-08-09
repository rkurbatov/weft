// The canonical text of a tree: the same shape gives the same string, whatever
// order the object keys came in. A tree holding a closure has no canon at all
// (null): it cannot travel, and it does not belong to the cross-corpus.

/** Canon of the tree, or null when a closure stands anywhere inside. */

import { canonExpr } from './expr.ts'
import type { Expr } from './expr.ts'
import type { RelNode, RowFn } from './contract.ts'
import { isExpr } from './inner.ts'

export function canonNode(node: RelNode): string | null {
  switch (node.prim) {
    case 'source':
      return `(source ${node.source} key=${node.key.join(',')})`
    case 'filter': {
      const under = canonNode(node.input)
      if (under === null || !isExpr(node.test)) return null
      return `(filter ${canonExpr(node.test)} ${under})`
    }
    case 'agg': {
      const under = canonNode(node.input)
      if (under === null) return null
      const parts: string[] = []
      for (const [name, decl] of Object.entries(node.folds).toSorted(([a], [b]) =>
        a < b ? -1 : 1,
      )) {
        if (decl.fold === 'custom') return null
        if (decl.fold === 'count') parts.push(`${name}=(count)`)
        else if (decl.fold === 'collect' && decl.of === undefined) {
          const by =
            decl.by === undefined
              ? ''
              : ` by=${decl.by.map(o => `${o.down === true ? '-' : '+'}${o.field}`).join(',')}`
          parts.push(`${name}=(collect${by})`)
        } else {
          const of = decl.of as Expr | RowFn
          if (!isExpr(of)) return null
          parts.push(`${name}=(${decl.fold} ${canonExpr(of)})`)
        }
      }
      return `(agg by=${node.by.join(',')} {${parts.join(' ')}} ${under})`
    }
    case 'union': {
      const left = canonNode(node.left)
      const right = canonNode(node.right)
      if (left === null || right === null) return null
      return `(union ${left} ${right})`
    }
    case 'scan': {
      const under = canonNode(node.input)
      if (under === null || !isExpr(node.step)) return null
      const order = node.order.map(o => `${o.down === true ? '-' : '+'}${o.field}`).join(',')
      const as = node.as === undefined ? '' : ` as=${node.as}`
      const through = node.through === undefined ? '' : ` through=${node.through}`
      const from = node.from === undefined ? '' : ` from=${node.from}`
      return `(scan by=${order} step=${canonExpr(node.step)}${as}${through}${from} ${under})`
    }
    case 'expand': {
      const under = canonNode(node.input)
      if (under === null) return null
      return `(expand .${node.field} as=${node.as} key=${node.key.join(',')} ${under})`
    }
    case 'join': {
      const left = canonNode(node.left)
      const right = canonNode(node.right)
      if (left === null || right === null) return null
      let residual = ''
      if (node.residual !== undefined) {
        if (!isExpr(node.residual)) return null
        residual = ` where=${canonExpr(node.residual)}`
      }
      const on = node.on.map(p => `${p.left}=${p.right}`).join(',')
      const keeping = node.keeping === true ? ' keeping' : ''
      return `(join as=${node.as} on=${on}${residual}${keeping} ${left} ${right})`
    }
    case 'pure': {
      const under = canonNode(node.input)
      if (under === null) return null
      const fields = Object.entries(node.fields ?? {}).toSorted(([a], [b]) => (a < b ? -1 : 1))
      const parts: string[] = []
      for (const [name, e] of fields) {
        if (!isExpr(e)) return null
        parts.push(`${name}=${canonExpr(e)}`)
      }
      const pick = node.pick === undefined ? '' : ` pick=${node.pick.join(',')}`
      return `(pure {${parts.join(' ')}}${pick} ${under})`
    }
  }
}
