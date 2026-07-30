// The hand-written sheet. Everything the graph does for us in the other demo is
// written out here, because it has to be: what each cell reads, who reads it,
// what a change makes stale, in what order the stale ones may be recomputed,
// which of them form a loop, and who has to be told afterwards.

import { refName } from '../common/address.ts'
import { read, referencesOfText, show, isError } from '../common/formula.ts'
import type { Value } from '../common/formula.ts'
import type { Sheet as Contents } from '../common/sheet.ts'

export interface Sheet {
    text(at: string): string
    value(at: string): Value
    /** What the cell shows. Kept as a string so React has something stable to compare. */
    shown(at: string): string
    set(at: string, text: string): void
    /** Told when this one cell's shown value changes. */
    subscribe(at: string, listener: () => void): () => void
    /** How many cell values were worked out since the last reset. */
    recomputes(): number
    resetRecomputes(): void
}

const CYCLE: Value = { error: '#CYCLE!' }

export function createSheet(initial: Contents): Sheet {
    const texts = new Map<string, string>(initial)
    const values = new Map<string, Value>()
    const shownText = new Map<string, string>()

    /** What each cell reads. */
    const reads = new Map<string, string[]>()
    /** Who reads each cell — the same thing backwards, and it must be kept in step by hand. */
    const readers = new Map<string, Set<string>>()

    const listeners = new Map<string, Set<() => void>>()
    let worked = 0

    function linkUp(at: string): void {
        for (const was of reads.get(at) ?? []) readers.get(was)?.delete(at)
        const now = referencesOfText(texts.get(at) ?? '').map(refName)
        reads.set(at, now)
        for (const ref of now) {
            let set = readers.get(ref)
            if (set === undefined) {
                set = new Set()
                readers.set(ref, set)
            }
            set.add(at)
        }
    }

    function valueOfCell(at: string): Value {
        return values.get(at) ?? ''
    }

    function work(at: string): boolean {
        worked++
        const value = read(texts.get(at) ?? '', { value: ref => valueOfCell(refName(ref)) })
        const before = shownText.get(at)
        const after = show(value)
        values.set(at, value)
        shownText.set(at, after)
        return before !== after
    }

    function tell(at: string): void {
        const set = listeners.get(at)
        if (set === undefined) return
        for (const listener of set) listener()
    }

    /** Everything that leans on this cell, however far away. */
    function stainedBy(at: string): Set<string> {
        const stained = new Set<string>([at])
        const queue = [at]
        while (queue.length > 0) {
            const next = queue.pop() as string
            for (const reader of readers.get(next) ?? []) {
                if (stained.has(reader)) continue
                stained.add(reader)
                queue.push(reader)
            }
        }
        return stained
    }

    /**
     * Kahn's ordering over the stained cells only. Whatever is left over when the
     * queue runs dry sits in a loop, and a loop has no value to speak of.
     */
    function orderOf(stained: Set<string>): { order: string[]; looped: string[] } {
        const waitingOn = new Map<string, number>()
        for (const at of stained) {
            let count = 0
            for (const ref of reads.get(at) ?? []) if (stained.has(ref)) count++
            waitingOn.set(at, count)
        }
        const ready = [...stained].filter(at => waitingOn.get(at) === 0)
        const order: string[] = []
        const placed = new Set<string>()
        let head = 0
        while (head < ready.length) {
            const at = ready[head++] as string
            order.push(at)
            placed.add(at)
            for (const reader of readers.get(at) ?? []) {
                if (!stained.has(reader)) continue
                const left = (waitingOn.get(reader) ?? 0) - 1
                waitingOn.set(reader, left)
                if (left === 0) ready.push(reader)
            }
        }
        const looped = [...stained].filter(at => !placed.has(at))
        return { order, looped }
    }

    function settle(stained: Set<string>): void {
        const { order, looped } = orderOf(stained)
        for (const at of looped) {
            const before = shownText.get(at)
            values.set(at, CYCLE)
            shownText.set(at, show(CYCLE))
            if (before !== show(CYCLE)) tell(at)
        }
        for (const at of order) {
            if (work(at)) tell(at)
        }
    }

    // The first pass: link everything, then work the whole sheet out in order.
    for (const at of texts.keys()) linkUp(at)
    settle(new Set(texts.keys()))

    return {
        text: at => texts.get(at) ?? '',
        value: at => valueOfCell(at),
        shown: at => shownText.get(at) ?? '',

        set(at, text) {
            texts.set(at, text)
            linkUp(at)
            settle(stainedBy(at))
        },

        subscribe(at, listener) {
            let set = listeners.get(at)
            if (set === undefined) {
                set = new Set()
                listeners.set(at, set)
            }
            set.add(listener)
            return () => {
                set?.delete(listener)
            }
        },

        recomputes: () => worked,
        resetRecomputes: () => {
            worked = 0
        },
    }
}

export { isError }