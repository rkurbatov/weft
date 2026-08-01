// Search by hand. The generation counter below is the race guard: an answer
// that comes back for an older query must not be applied over a newer one.
// The guard can be switched off — then this page behaves the way most
// first-draft search code actually does, and the race is visible to the eye:
// type "sto" quickly, and the slow answer for "s" lands last and wins.

import { useEffect, useRef, useState } from 'react'
import { suggest } from '../search-common/server.ts'

export function App() {
    const [query, setQuery] = useState('')
    const [hints, setHints] = useState<string[]>([])
    const [answered, setAnswered] = useState('')
    const [busy, setBusy] = useState(false)
    const [guarded, setGuarded] = useState(true)

    // The race guard: each request remembers which generation it belongs to,
    // and an answer from an older generation is thrown away.
    const generation = useRef(0)

    useEffect(() => {
        const mine = ++generation.current
        if (query === '') {
            setHints([])
            setAnswered('')
            setBusy(false)
            return
        }
        setBusy(true)
        void suggest(query).then(got => {
            if (guarded && generation.current !== mine) return // too late, newer query rules
            setHints(got)
            setAnswered(query)
            setBusy(false)
        })
        return () => {
            generation.current++ // leaving is also a newer generation
        }
    }, [query, guarded])

    const raced = answered !== '' && answered !== query

    return (
        <main className="search">
            <h1>Search without races — by hand</h1>
            <p className="which">
                A shorter query answers slower here, on purpose. The generation counter keeps an old
                answer from landing over a new one; switch it off and type "sto" quickly to watch the
                answer for "s" win.
            </p>
            <input
                type="text"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder='Type "sto" quickly, then erase back to "s"…'
            />
            <div className="row">
                <label>
                    <input
                        type="checkbox"
                        checked={guarded}
                        onChange={event => setGuarded(event.target.checked)}
                    />{' '}
                    race guard
                </label>
                <span>{busy ? 'asking…' : ''}</span>
                <span>
          {answered !== '' && (
              <>
                  answers for “{answered}”{raced && <span className="bad"> — not what the box says!</span>}
              </>
          )}
        </span>
            </div>
            <ul className={busy ? 'hints faded' : 'hints'}>
                {hints.map(word => (
                    <li key={word}>{word}</li>
                ))}
            </ul>
        </main>
    )
}