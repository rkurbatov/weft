// The screen. Typing moves the watcher to another query's source; the one left
// behind loses its demand and goes quiet. Erase back within half a minute and
// the answer is already there — shelf life, declared where the source is made.

import { useCell, useSource } from '#weft/react'
import { suggest } from '../search-common/server.ts'
import { searchState } from './state.ts'

const state = searchState({ suggest })

export function App() {
    const query = useCell(state.query)
    const hints = useSource(state.suggestions(query))

    return (
        <main className="search">
            <h1>Search without races — on weft</h1>
            <p className="which">
                The same slow server. There is no race guard on this page, because an answer for an old
                query has nowhere to land: the screen watches the source of the query in the box.
            </p>
            <input
                type="text"
                value={query}
                onChange={event => state.query.set(event.target.value)}
                placeholder='Type "sto" quickly, then erase back to "s"…'
            />
            <div className="row">
                <span>{hints.loading ? 'asking…' : ''}</span>
            </div>
            <ul className={hints.loading ? 'hints faded' : 'hints'}>
                {(hints.value ?? []).map(word => (
                    <li key={word}>{word}</li>
                ))}
            </ul>
        </main>
    )
}