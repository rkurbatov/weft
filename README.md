# weft

The weft woven across Warp's warp: a live-state layer — a cell graph that lives outside the React tree, delivery owned by sources, requirements stated from above. A TypeScript library that runs alongside whatever you already have; Redux can stay switched on while domains move over one at a time.

The rule everything else follows from: **store only what came from outside**. Anything computable is a formula, and its dependencies are written once — inside it. The test for a broken model: if you ever need the word *invalidate*, some dependency is written down twice.

## What's here

**`src/core/graph.ts` — the graph.** Stored cells (`input`) with exactly one writer each; derived cells (`cell`) whose dependencies come from reading, never from a declared list; watchers (`watch`, `subscribe`); write batches (`batch`).

Propagation is pull-based over three states. A write marks its direct consumers dirty and everything below them as "check"; watchers queue, and on drain they walk up their own sources to find out whether anything really moved. The point of the middle state is the gate: a formula that recomputes to an equal value does not mark its consumers, so the wave dies there instead of reaching the screen. Cycles are reported with the cell's name rather than hanging.

Tested properties: a formula nobody reads is never run; a diamond recomputes once, not twice; a watcher never sees a half-updated picture; the branch a conditional didn't take is not a dependency; a write from inside a watcher settles in the same round.

**`src/core/command.ts` — commands.** The only way anything reaches the world. A handle gives you the start (`run`), the wait (it returns a promise), and the observable state — idle, running, done, failed, with timestamps. `pending`, `result` and `error` are ordinary cells, so a formula may depend on them: a button greys out because its own condition reads `pending`, not because someone set a flag next to it. Failure is a state *and* a rejected promise, so the caller can handle it on the spot as well.

What a second press does is declared, not hand-rolled. `drop` (the default) makes the second press ride the first promise and runs the body once — that is double-submit protection. `restart` is for search and suggestions: the older attempt loses its claim on the state through a generation counter, so its answer is ignored rather than applied late over the newer one.

**`src/core/family.ts` — families.** One cell per entity, built on first demand: `item(id)` hands back the same cell for the same key, so a card subscribes to its own row and nothing else. A member nobody watches is a cache entry rather than state, so it is dropped past a stated ceiling (LRU) or on `sweep()`; a watched member is never dropped, because its watchers hold that very cell. Dropping is not destruction — the next read rebuilds the member from its current sources. Object keys need a `keyOf`; strings, numbers, booleans and bigints work as they are.

**`src/react/hooks.ts` — the seam,** deliberately thin. `useCell` subscribes a component to one value through `useSyncExternalStore`. `useCommand` hands a command to the tree with a stable `start` reference, so it can go straight into handlers and dependency arrays.

## What's next

In order, one at a time: adapters that own delivery and pace; cell state (empty, in flight, value with an age, refused); freshness requirements and their withdrawal; persistence of stored cells with age and schema version; an outbox for commands with idempotency keys; reconciliation.

## Imports

Anything crossing a directory goes through Node's own subpath imports, declared in `package.json`; inside a directory, relative paths stay relative.

```json
"imports": {
  "#core/*": "./src/core/*",
  "#react/*": "./src/react/*"
}
```

`import { cell } from '#core/graph.ts'` is resolved by Node itself and understood by the compiler under `nodenext` — no bundler config and no `paths` mapping to keep in sync with it.

## Running it

```
pnpm test    # tests, straight over TypeScript — no build step
pnpm check   # types
```

Node 26 strips types on its own; on Node 22.6+ add `--experimental-strip-types` to the test script.