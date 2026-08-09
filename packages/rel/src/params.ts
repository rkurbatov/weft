// Holes in a tree and how they are filled. The tree with holes is the identity
// of the query; substituting values gives the tree that actually runs.

/** The same tree with every hole filled — what actually runs; the original,
 *  holes and all, stays the tree's identity. */

import type { Expr } from './expr.ts'
import type { FoldDecl, JoinNode, PureNode, RelNode, RowFn } from './contract.ts'
import { paramsOfE, subExpr, subFold } from './inner.ts'

export function substituteNode(node: RelNode, values: ReadonlyMap<string, unknown>): RelNode {
  switch (node.prim) {
    case 'source':
      return node
    case 'filter':
      return {
        ...node,
        input: substituteNode(node.input, values),
        test: subExpr(node.test, values),
      }
    case 'pure': {
      const out: PureNode = { ...node, input: substituteNode(node.input, values) }
      if (node.fields !== undefined) {
        const fields: Record<string, Expr | RowFn> = {}
        for (const [name, e] of Object.entries(node.fields)) fields[name] = subExpr(e, values)
        out.fields = fields
      }
      return out
    }
    case 'join': {
      const out: JoinNode = {
        ...node,
        left: substituteNode(node.left, values),
        right: substituteNode(node.right, values),
      }
      if (node.residual !== undefined) out.residual = subExpr(node.residual, values)
      return out
    }
    case 'agg': {
      const folds: Record<string, FoldDecl> = {}
      for (const [name, decl] of Object.entries(node.folds)) folds[name] = subFold(decl, values)
      return { ...node, input: substituteNode(node.input, values), folds }
    }
    case 'union':
      return {
        ...node,
        left: substituteNode(node.left, values),
        right: substituteNode(node.right, values),
      }
    case 'expand':
      return { ...node, input: substituteNode(node.input, values) }
    case 'scan':
      return {
        ...node,
        input: substituteNode(node.input, values),
        step: subExpr(node.step, values),
      }
  }
}

export function paramsOfNode(node: RelNode, out: Set<string> = new Set()): Set<string> {
  switch (node.prim) {
    case 'source':
      return out
    case 'filter':
      paramsOfE(node.test, out)
      return paramsOfNode(node.input, out)
    case 'pure':
      for (const e of Object.values(node.fields ?? {})) paramsOfE(e, out)
      return paramsOfNode(node.input, out)
    case 'join':
      if (node.residual !== undefined) paramsOfE(node.residual, out)
      paramsOfNode(node.left, out)
      return paramsOfNode(node.right, out)
    case 'agg':
      for (const decl of Object.values(node.folds)) {
        if (decl.fold !== 'count' && decl.fold !== 'custom' && decl.of !== undefined) {
          paramsOfE(decl.of, out)
        }
      }
      return paramsOfNode(node.input, out)
    case 'union':
      paramsOfNode(node.left, out)
      return paramsOfNode(node.right, out)
    case 'expand':
      return paramsOfNode(node.input, out)
    case 'scan':
      paramsOfE(node.step, out)
      return paramsOfNode(node.input, out)
  }
}
