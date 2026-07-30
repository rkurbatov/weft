// Which cells a formula names. Only the hand-written sheet needs this: it has to
// know the dependencies in advance, because nothing records them for it.

import { spanRefs } from '../common/address.ts'
import { plan } from '../common/formula.ts'
import type { Node } from '../common/formula.ts'
import type { Ref } from '../common/address.ts'

export function refsIn(node: Node): Ref[] {
    switch (node.kind) {
        case 'ref':
            return [node.ref]
        case 'range':
            return spanRefs(node.from, node.to)
        case 'unary':
            return refsIn(node.of)
        case 'binary':
            return [...refsIn(node.left), ...refsIn(node.right)]
        case 'call':
            return node.args.flatMap(refsIn)
        default:
            return []
    }
}

/** The cells this text reads, in the order it reads them. */
export function refsOf(text: string): Ref[] {
    const what = plan(text)
    return what.kind === 'formula' ? refsIn(what.node) : []
}