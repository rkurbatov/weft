// The same sheet on weft. What the other demo spells out — who reads whom, what
// a change makes stale, in what order to recompute, who to tell — is not written
// here at all, because reading is what records a dependency.

import { batch, family, input, untracked } from '#weft'
import type { Cell, Input } from '#weft'
import { refName } from '../common/address.ts'
import { read, show } from '../common/formula.ts'
import type { Value } from '../common/formula.ts'
import type { Sheet as Contents } from '../common/sheet.ts'

const LOOP: Value = { error: '#CYCLE!' }

export interface Sheet {
    text(at: string): string
    value(at: string): Value
    /** What the cell shows. A cell of its own, so an unchanged look wakes nobody. */
    shown(at: string): Cell<string>
    set(at: string, text: string): void
    /** Several edits as one settling. */
    edit(changes: Iterable<[string, string]>): void
    recomputes(): number
    resetRecomputes(): void
}

export function createSheet(initial: Contents): Sheet {
    const texts = new Map<string, Input<string>>()
    let worked = 0

    function textOf(at: string): Input<string> {
        let box = texts.get(at)
        if (box === undefined) {
            box = input('', { name: at })
            texts.set(at, box)
        }
        return box
    }

    const values = family(
        (at: string): Value => {
            worked++
            return read(textOf(at).get(), { value: ref => valueAt(refName(ref)) })
        },
        { name: 'value', max: 500_000 },
    )

    /**
     * A loop is the graph's own complaint: reading a cell that is busy computing
     * throws, and here that becomes an ordinary spreadsheet error. There is no
     * cycle search anywhere — this is it.
     */
    function valueAt(at: string): Value {
        try {
            return values(at).get()
        } catch {
            return LOOP
        }
    }

    const shownAt = family((at: string) => show(valueAt(at)), { name: 'shown', max: 500_000 })

    for (const [at, text] of initial) textOf(at).set(text)

    return {
        text: at => untracked(() => textOf(at).peek()),
        value: at => untracked(() => valueAt(at)),
        shown: at => shownAt(at),

        set(at, text) {
            textOf(at).set(text)
        },

        edit(changes) {
            batch(() => {
                for (const [at, text] of changes) textOf(at).set(text)
            })
        },

        recomputes: () => worked,
        resetRecomputes: () => {
            worked = 0
        },
    }
}