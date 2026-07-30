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

**`src/core/remote.ts` — the state of what came from outside.** One shape — empty, in flight, a value with the moment it arrived, or a refusal — instead of a value with flags beside it. A flight and a refusal both carry whatever is already held, so a screen keeps showing the last good answer instead of blanking; `valueOf`, `ageOf` and `isFresh` read that off.

**`src/core/source.ts` — sources.** Delivery lives here and nowhere else: fetching, polling, shelf life, retries with growing waits. A source runs only while something live watches it — the first watcher starts it, the last one to leave stops it, and an unwatched screen therefore costs nothing. A new watcher within shelf life gets the answer already held; past it, a refetch. A second demand rides the flight already under way instead of duplicating it; `refresh({ force: true })` starts a new one and disowns the older answer. The clock and the timers are injectable, so all of this is tested without waiting.

**`src/core/graph.ts` — demand.** The graph counts demand along its links, which is what lets a source know it is being watched: a watcher contributes one, a formula passes it up while anything demands it, and dropping a dependency releases the source it held. Source hooks run after the graph settles, never inside a formula, so an adapter may write its own cell from them.

**Requirements.** A consumer states what it needs rather than arranging how to get it: `feed.require(200)` says "this must not be older than 200ms" and hands back the withdrawal. The strictest live requirement sets the pace; when it goes, the pace relaxes to the next one; when the last goes, the source falls quiet. Stating a requirement against something already too old asks at once instead of waiting for the next turn of the wheel. A source may declare a `floor` it will not be asked below, and `onUnmet` is told when a requirement asks for more than the floor allows — the honest limit of a library: it can report at runtime what a compiler would refuse before it ran.

`fresh(feed, within)` ties the two together: a view of a source that holds a requirement for exactly as long as somebody watches it, so nothing has to be released by hand. In React that is `useSource(feed, { within: 200 })` — mounting is the requirement, unmounting withdraws it.

**`src/react/hooks.ts` — the seam,** deliberately thin. `useCell` subscribes a component to one value through `useSyncExternalStore`. `useCommand` hands a command to the tree with a stable `start` reference, so it can go straight into handlers and dependency arrays.

## What's next

In order, one at a time: persistence of stored cells with age and schema version; an outbox for commands with idempotency keys; reconciliation.

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