import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subscribe } from '#core/graph.ts'
import { searchState } from './state.ts'

function settle(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
}

/** A server under the test's thumb: answers only when told, per query. */
function handServer() {
    const gates = new Map<string, Array<(hints: string[]) => void>>()
    let asked: string[] = []
    return {
        asked: () => asked,
        forget: () => {
            asked = []
        },
        suggest: (query: string) =>
            new Promise<string[]>(resolve => {
                asked.push(query)
                const line = gates.get(query) ?? []
                line.push(resolve)
                gates.set(query, line)
            }),
        async answer(query: string, hints: string[]) {
            const line = gates.get(query) ?? []
            const gate = line.shift()
            assert.notEqual(gate, undefined, `nobody asked for "${query}"`)
            gate!(hints)
            await settle()
        },
    }
}

test('an old answer has nowhere to land: the race cannot be written', async () => {
    const server = handServer()
    const state = searchState(server)

    // The screen types "s", then quickly "st"; the watcher moves with the box.
    let stop = subscribe(state.suggestions('s').state, () => {})
    await settle()
    stop()
    stop = subscribe(state.suggestions('st').state, () => {})
    await settle()

    // The fast answer for "st" lands first; the slow one for "s" limps in later.
    await server.answer('st', ['stack', 'stone'])
    await server.answer('s', ['sea', 'sun'])

    // What the screen watches holds the answer for its own query — the answer
    // for "s" went to the cell of "s", which nobody is looking at.
    assert.deepEqual(state.suggestions('st').state.peek().value, ['stack', 'stone'])
    stop()
})

test('an empty query never asks the server', async () => {
    const server = handServer()
    const state = searchState(server)
    const stop = subscribe(state.suggestions('').state, () => {})
    await settle()
    assert.deepEqual(server.asked(), [])
    assert.deepEqual(state.suggestions('').state.peek().value, [])
    stop()
})

test('erasing back within shelf life shows the answer at once, without asking again', async () => {
    const server = handServer()
    const state = searchState(server)

    let stop = subscribe(state.suggestions('st').state, () => {})
    await settle()
    await server.answer('st', ['stack', 'stone'])
    stop()

    // The box moves on and comes back; the answer is young enough to serve as is.
    stop = subscribe(state.suggestions('sto').state, () => {})
    await settle()
    stop()
    server.forget()
    stop = subscribe(state.suggestions('st').state, () => {})
    await settle()
    assert.deepEqual(server.asked(), []) // nobody was asked
    assert.deepEqual(state.suggestions('st').state.peek().value, ['stack', 'stone'])
    stop()
})