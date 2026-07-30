# weft

The weft woven across Warp's warp: a live-state layer — a cell graph that lives outside the React tree, delivery owned by sources, requirements stated from above. A TypeScript library that runs alongside whatever you already have; Redux can stay switched on while domains move over one at a time.

The rule everything else follows from: **store only what came from outside**. Anything computable is a formula, and its dependencies are written once — inside it. The test for a broken model: if you ever need the word _invalidate_, some dependency is written down twice.

## What's here

**`src/core/graph.ts` — the graph.** Stored cells (`input`) with exactly one writer each; derived cells (`cell`) whose dependencies come from reading, never from a declared list; watchers (`watch`, `subscribe`); write batches (`batch`).

Propagation is pull-based over three states. A write marks its direct consumers dirty and everything below them as "check"; watchers queue, and on drain they walk up their own sources to find out whether anything really moved. The point of the middle state is the gate: a formula that recomputes to an equal value does not mark its consumers, so the wave dies there instead of reaching the screen. Cycles are reported with the cell's name rather than hanging.

Tested properties: a formula nobody reads is never run; a diamond recomputes once, not twice; a watcher never sees a half-updated picture; the branch a conditional didn't take is not a dependency; a write from inside a watcher settles in the same round.

**`src/core/command.ts` — commands.** The only way anything reaches the world. A handle gives you the start (`run`), the wait (it returns a promise), and the observable state — idle, running, done, failed, with timestamps. `pending`, `result` and `error` are ordinary cells, so a formula may depend on them: a button greys out because its own condition reads `pending`, not because someone set a flag next to it. Failure is a state _and_ a rejected promise, so the caller can handle it on the spot as well.

What a second press does is declared, not hand-rolled. `drop` (the default) makes the second press ride the first promise and runs the body once — that is double-submit protection. `restart` is for search and suggestions: the older attempt loses its claim on the state through a generation counter, so its answer is ignored rather than applied late over the newer one.

**`src/core/family.ts` — families.** One cell per entity, built on first demand: `item(id)` hands back the same cell for the same key, so a card subscribes to its own row and nothing else. A member nobody watches is a cache entry rather than state, so it is dropped past a stated ceiling (LRU) or on `sweep()`; a watched member is never dropped, because its watchers hold that very cell. Dropping is not destruction — the next read rebuilds the member from its current sources. Object keys need a `keyOf`; strings, numbers, booleans and bigints work as they are.

**`src/core/remote.ts` — the state of what came from outside.** One shape — empty, in flight, a value with the moment it arrived, or a refusal — instead of a value with flags beside it. A flight and a refusal both carry whatever is already held, so a screen keeps showing the last good answer instead of blanking; `valueOf`, `ageOf` and `isFresh` read that off.

**`src/core/source.ts` — sources.** Delivery lives here and nowhere else: fetching, polling, shelf life, retries with growing waits. A source runs only while something live watches it — the first watcher starts it, the last one to leave stops it, and an unwatched screen therefore costs nothing. A new watcher within shelf life gets the answer already held; past it, a refetch. A second demand rides the flight already under way instead of duplicating it; `refresh({ force: true })` starts a new one and disowns the older answer. The clock and the timers are injectable, so all of this is tested without waiting.

**`src/core/graph.ts` — demand.** The graph counts demand along its links, which is what lets a source know it is being watched: a watcher contributes one, a formula passes it up while anything demands it, and dropping a dependency releases the source it held. Source hooks run after the graph settles, never inside a formula, so an adapter may write its own cell from them.

**Requirements.** A consumer states what it needs rather than arranging how to get it: `feed.require(200)` says "this must not be older than 200ms" and hands back the withdrawal. The strictest live requirement sets the pace; when it goes, the pace relaxes to the next one; when the last goes, the source falls quiet. Stating a requirement against something already too old asks at once instead of waiting for the next turn of the wheel. A source may declare a `floor` it will not be asked below, and `onUnmet` is told when a requirement asks for more than the floor allows — the honest limit of a library: it can report at runtime what a compiler would refuse before it ran.

`fresh(feed, within)` ties the two together: a view of a source that holds a requirement for exactly as long as somebody watches it, so nothing has to be released by hand. In React that is `useSource(feed, { within: 200 })` — mounting is the requirement, unmounting withdraws it.

**`src/core/keep.ts` — persistence.** Only stored cells are kept; a formula is recomputed, never restored. What is written carries the moment it arrived and a schema version, so an answer that survives a reload is honest about its age: within shelf life it is served as it stands and nothing is asked, past it the first demand refetches while the old value stays on screen. Another version is dropped unless a `migrate` rescues it; anything past `maxAge` is dropped; rubbish on disk is dropped rather than thrown. A refusal never overwrites a good answer. Watching is cold — persistence records what happens anyway and asks for nothing, so keeping a source does not make it fetch.

The cold watch is a graph primitive: `watch(body, { demand: false })` sees the changes that occur anyway without counting as demand. Persistence, logging and devtools want exactly that.

**`src/core/outbox.ts` — the outbox.** A command that reached for the world is written down before it is sent and leaves the book only when the world confirms it, so a tab dying mid-flight loses nothing. Each entry carries an idempotency key — the same one on every attempt, including after a reload — which is what makes a repeat safe rather than a second purchase. Entries go one at a time in the order they were written: order is part of the promise. A refusal is retried with growing waits; past `maxAttempts` the entry gets stuck and waits for a person, and `again(id)` or `forget(id)` decides its fate. An entry whose handler is unknown after a deploy gets stuck rather than vanishing. What is owed is an ordinary cell, so a screen can show "3 unsent" without asking anybody.

**`src/core/reconcile.ts` — reconciliation.** Something outside must match a value inside: request headers match the identity, a socket subscription matches the row on show. The rule is to watch the value itself rather than the events that might have changed it — then there is no list of triggers, and nothing to go stale when a fourth thing starts feeding that value. Following is cold by default: a reconciliation does not keep a source awake on its own, though `demand: true` says otherwise. While one value is being applied a newer one supersedes the ones between, because the world was never in those states. Refusals are retried with growing waits and then reported; a new value clears the refusal and starts over.

**`src/react/hooks.ts` — the seam,** deliberately thin. `useCell` subscribes a component to one value through `useSyncExternalStore`. `useCommand` hands a command to the tree with a stable `start` reference, so it can go straight into handlers and dependency arrays.

## Where it stands

The line of work this repository set out to do is done: graph, commands, families, remote state, sources with demand-driven delivery, freshness requirements, persistence, an outbox, reconciliation — 87 tests, no build step, no runtime dependencies. `src/index.ts` is the front door; React lives behind `#react/hooks.ts` so the graph stays usable and testable without it.

What is not done, and should be said plainly: none of this has met a real application yet. The next honest step is one domain of a live product moved over whole — not a demo — and the numbers that come out of it. After that, the parts a library cannot reach: purity by construction, a verdict before the program runs, and incremental recomputation inside a formula rather than around it.

## What the library asks of values

The graph does not know what is in a cell, and does not want to. What it does rely on, stated plainly:

**A formula is pure and settled.** Given the same inputs it gives the same result, and it reaches for nothing else — no clock, no random, no fetch. A formula that reads the time is a formula whose value is wrong the moment it is cached.

**Equality is a real equivalence relation.** Propagation stops where a recomputed value equals the old one, so `equal` decides what the rest of the system believes. The default is `Object.is`, which is right for numbers, strings and shared objects, and wrong for a value rebuilt on every run — pass an `equal` that compares content, or the wave never dies. (`0` and `-0` are different under `Object.is`; a formula flipping between them wakes watchers for nothing.)

**Anything to be recomputed in pieces must be exact and associative in its own type.** This one is not needed yet — whole formulas are recomputed whole — but it is the price of the next step. A block-wise total is only the same number as a left-to-right total if addition is associative, and floating point's is not. That is why the demo carries its own decimal arithmetic (`demo/common/dec.ts`, a count of millionths in an integer), and why in Warp the decimal types are the floor while binary floats are for physics rather than for anything the engine reassembles.

## Two spreadsheets

`demo/` holds the same spreadsheet twice: `spreadsheet/` keeps its state by hand, `spreadsheet-weft/` keeps it on this library. The grid, the formula language, the sample sheet and the instrumentation are shared in `demo/common/`, so what differs is only who keeps the values.

The hand-written one needs 208 lines for that: a store of texts, what each cell reads and who reads it kept in both directions, the transitive stain of a change, Kahn's order over it, a loop search for whatever the order leaves out, and a subscription per cell. The weft one needs 84, and none of those words appear in it — a cell's text is an `input`, its value is a `family` member whose formula reads its neighbours, and reading is what records the dependency. A loop is not searched for: reading a cell that is busy computing throws, and that becomes `#CYCLE!`.

Both pass the same seven questions (`store.test.ts`, `sheet.test.ts`) — the same values, the same cells told, the same recovery when a loop is cut. What differs is the bill. On a sheet of 26,000 cells with 780 on screen, measured by `pnpm demo:bench`:

```
classic   build 192ms | edit A1 8.1ms | recomputed 242 | cells told 53
on weft   lay out 11ms + first look 12ms (780 cells) | edit A1 0.8ms | recomputed 84 | cells told 53
```

Ten times cheaper per edit, and the gap widens with the sheet: at 130,000 cells the hand-written one spends seconds getting started and tens of milliseconds on a single change. The reason is not a faster engine — it is that the hand-written sheet works out every cell whether anyone is looking or not, while demand decides here. The same 53 cells are told in both, which is the point: same behaviour, different price, much less written down.

Run it yourself rather than trusting the figures — they are one machine's, and the ratios are what matter.

## Blocks

`demo/spreadsheet-weft/blocks.ts` answers a long total from a tree of partial sums rather than by reading every cell: blocks of 32, blocks of blocks above them, each partial an ordinary cell. One edit then touches one partial per level and the total. Trees run both ways — down a column and along a row — and a rectangle is cut into lines along its longer side, since that is the side a tree pays on.

It is worth building here and nowhere else. Each partial is a cell, so what depends on what — and what has to be redone — is the graph's business; the hand-written sheet could keep the same tree, but would have to invalidate it level by level, by hand. And it is only correct because the arithmetic underneath is exact: a total assembled from blocks is the same number as a total added left to right, which floating point would not give.

Measured with the totals row on screen, so the column sums are live (`pnpm demo:bench 15000`, 390,000 cells):

```
classic   edit A1 195ms | recomputed 242
on weft   edit A1 425ms | blocks off
on weft   edit A1   8ms | blocks on
```

The middle line is the honest one: without blocks this arrangement is _worse_ than the hand-written sheet, because each of the 26 column sums reads its whole column through the graph rather than through a plain array. With blocks the same answer costs a few dozen small sums. Turning them off (`createSheet(cells, { blocks: false })`) is what the middle line measures.

Chasing that middle line also found a real fault in the library: `family` reordered its LRU on every read — a map delete and insert per lookup — which is pure cost while the ceiling is far away. Reordering now happens only as the ceiling comes into sight, and the same scene went from 95ms to 16ms.

## One package

The library, its tests and the demos are a single package with one `tsconfig.json` and one set of scripts. Nothing crosses a package boundary, so nothing has to be kept in step: no workspace, no alias table, no second compiler config.

Anything crossing a directory goes through Node's own subpath imports, declared in `package.json`; inside a directory, relative paths stay relative.

```json
"imports": {
  "#core/*": "./src/core/*",
  "#react/*": "./src/react/*",
  "#weft": "./src/index.ts",
  "#weft/react": "./src/react/hooks.ts"
}
```

`import { cell } from '#core/graph.ts'` inside the library, `import { input, family } from '#weft'` from a demo — resolved by Node itself, understood by the compiler under `nodenext`, and understood by Vite. There is no `paths` mapping and no bundler alias to drift.

## Running it

```
pnpm test          # library and demo tests in one run
pnpm check         # types, including the Vite config
pnpm lint          # oxlint
pnpm format        # oxfmt, in place (format:check to only look)
pnpm demo          # the two spreadsheets, side by side
pnpm demo:build    # then demo:preview to serve what was built
pnpm demo:bench    # the two sheets measured against each other, without React
```

Node 26 strips types on its own, so there is no build step for the library or its tests; Vite is only there for the demos.
