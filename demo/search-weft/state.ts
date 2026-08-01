// The same on weft. A different query is a different source; the screen watches
// the source of the query in the box, so an old answer has nowhere to land — it
// belongs to a cell nobody is looking at. There is no race guard in this file
// because there is nothing to guard.

import { input, source } from '#weft'
import type { Source } from '#weft'

export interface SearchWorld {
    suggest: (query: string) => Promise<string[]>
}

export function searchState(world: SearchWorld) {
    const query = input('', { name: 'query' })

    // One source per query, made on first use. The pending queries layer will
    // grow this into a proper family with a ceiling; the demo keeps it plain.
    const sources = new Map<string, Source<string[]>>()
    const suggestions = (q: string): Source<string[]> => {
        let feed = sources.get(q)
        if (feed === undefined) {
            feed =
                q === ''
                    ? source(() => Promise.resolve<string[]>([]), { name: 'suggest:' })
                    : source(() => world.suggest(q), { name: `suggest:${q}`, shelfLife: 30_000 })
            sources.set(q, feed)
        }
        return feed
    }

    return { query, suggestions }
}