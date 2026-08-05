# Weft

The weft woven across Warp's warp: a live-state engine — a cell graph that lives outside the React tree, delivery owned by sources, requirements stated from above. A TypeScript library that runs alongside whatever you already have; Redux can stay switched on while domains move over one at a time.

The rule everything else follows from: **store only what came from outside**. Anything computable is a formula, and its dependencies are written once — inside it. The test for a broken model: if you ever need the word _invalidate_, some dependency is written down twice.

## Who this is for

Three things share this line of work, and they are judged differently.

**Warp** is the language the model came from; its corpus lives in its own repository.

**Weft** — `src/weft` — is the engine: the same semantics running today, without a compiler, in a browser. It is judged by whether it is sufficient, flexible and fast, not by whether it reads nicely. Nobody is expected to write an application directly against it.

**Loom** — `src/loom` — is the speech of Weft for the person writing an application: five words, one seam, and a carrier. Everything about readability is asked of Loom.

So this README is the machine room. If you want to know how an application is written, read the dialect; if you want to know how the machinery works, or you are writing another translator over the same engine, you are in the right place.

## What's here

**`src/weft/core/graph/graph.ts` — the graph.** Stored cells (`input`) with exactly one writer each; derived cells (`cell`) whose dependencies come from reading, never from a declared list; watchers (`watch`, `subscribe`); write batches (`batch`).

Propagation is pull-based over three states. A write marks its direct consumers dirty and everything below them as "check"; watchers queue, and on drain they walk up their own sources to find out whether anything really moved. The point of the middle state is the gate: a formula that recomputes to an equal value does not mark its consumers, so the wave dies there instead of reaching the screen. Cycles are reported with the cell's name rather than hanging.

Tested properties: a formula nobody reads is never run; a diamond recomputes once, not twice; a watcher never sees a half-updated picture; the branch a conditional didn't take is not a dependency; a write from inside a watcher settles in the same round.

**Demand,** also in the graph. It is counted along the links, which is what lets a source know it is being watched: a watcher contributes one, a formula passes it up while anything demands it, and dropping a dependency releases the source it held. Source hooks run after the graph settles, never inside a formula, so an adapter may write its own cell from them. The cold watch is a primitive too — `watch(body, { demand: false })` sees the changes that occur anyway without counting as demand, which is exactly what persistence, logging and devtools want.

**`src/weft/core/graph/command.ts` — commands.** A handle gives you the start (`run`), the wait (it returns a promise), and the observable state — idle, running, done, failed, with timestamps. `pending`, `result` and `error` are ordinary cells, so a formula may depend on them: a button greys out because its own condition reads `pending`, not because someone set a flag next to it. Failure is a state _and_ a rejected promise.

What a second press does is declared, not hand-rolled. `drop` (the default) makes the second press ride the first promise and runs the body once — that is double-submit protection. `restart` is for search and suggestions: the older attempt loses its claim on the state through a generation counter, so its answer is ignored rather than applied late over the newer one.

**`src/weft/core/graph/family.ts` — families.** One cell per entity, built on first demand: `item(id)` hands back the same cell for the same key, so a card subscribes to its own row and nothing else. A member nobody watches is a cache entry rather than state, so it is dropped past a stated ceiling (LRU) or on `sweep()`; a watched member is never dropped, because its watchers hold that very cell. Dropping is not destruction — the next read rebuilds the member from its current sources. Object keys need a `keyOf`; strings, numbers, booleans and bigints work as they are.

**`src/weft/core/remote/remote.ts` — the state of what came from outside.** One shape — empty, in flight, a value with the moment it arrived, or a refusal — instead of a value with flags beside it. A flight and a refusal both carry whatever is already held, so a screen keeps showing the last good answer instead of blanking. Every variant carries the same flat fields — `state.value`, `state.at`, `state.error`, `state.loading` — so a screen reads it without helpers, while `kind` keeps the exact story. A refusal names its kind: transient, permanent, rejected — plus `unknown`, which is not a refusal at all but a third outcome, the one where the world may well have done the work.

`together` and `firstOf` reduce several outcomes into one: all-of, where the first refusal follows declaration order and the summary is as old as its oldest part; and first-of, where argument order is priority rather than a race, and among the empty-handed hope outranks refusal.

**`src/weft/core/remote/source.ts` — sources.** Delivery lives here and nowhere else: fetching, polling, shelf life, retries with growing waits and jitter. A source runs only while something live watches it — the first watcher starts it, the last one to leave stops it, and an unwatched screen therefore costs nothing. A new watcher within shelf life gets the answer already held; past it, a refetch. A second demand rides the flight already under way, and losing demand aborts that flight through the signal the loader was handed. `calm` is the quiet a look must outlive before a question is asked — debounce as a line in the passport rather than an operator over a stream. A timeout resolves to `unknown` rather than a refusal, and only transient and unknown outcomes retry by themselves: a source is a read, and a read is safe to repeat. The clock and the timers are injectable, so all of this is tested without waiting.

**Requirements.** A consumer states what it needs rather than arranging how to get it: `feed.require(200)` says "this must not be older than 200ms" and hands back the withdrawal. The strictest live requirement sets the pace; when it goes, the pace relaxes to the next one; when the last goes, the source falls quiet. A source may declare a `floor` it will not be asked below, and `onUnmet` is told when a requirement asks for more than the floor allows — the honest limit of a library: it reports at runtime what a compiler would refuse before the program ran. `fresh(feed, within)` ties the two together, and `arrivalOf(feed)` is the promise of a landing: asking for it is itself demand, which is what makes suspense honest rather than a forced fetch.

**`src/weft/core/remote/query.ts` — parametric sources.** A family of sources by key: the same key is the same source, so identical questions collapse by construction, and a changed key is simply another source — the old one loses demand and falls quiet, which is what cancellation amounts to here. Seniority is a law rather than machinery: a new question devalues an unresolved old one, and a late answer is not accepted even into its own cell. The ceiling is stated, never silent, and only unwatched members count against it. Next to `family` this is not a duplicate but the other half of the pair: a family keeps a **cell** per key — a row of state the application writes and reads — while a query keeps a **source** per key, with a passport of its own: fetching, polling, shelf life, retries. Same keying, different thing kept.

**`src/weft/core/table/table.ts` — live collections.** Entities by identity, fed by deltas: `put`, `drop`, `apply`, `replace`, with `wins` deciding seniority when a late page meets a fresh event. Views are ordinary cells — `where`, `whereLive` (the predicate is itself a formula, so a filter typed into a field re-filters the view and followers still hear only the difference), `orderBy` with `slice` (a window that wakes only when the window moves), `fold` with an inverse where one exists, `count`, `sumBy`, `row(key)`, `rank(key)`. A change log lets a follower that fell behind resync by difference instead of rebuilding. Tested against an oracle: three hundred random operations against a naive recomputation at every step.

**`src/weft/core/table/offsets.ts` — the measured line.** What virtualisation asks a hundred times per scroll: where a row starts, and which row is at a pixel. A flat Fenwick tree over plain numbers, fed by deltas — a row measured anew is a point update in O(log n), an offset a prefix sum, a hit test a descent — with no cell per row, which is what the granularity law prescribes for small elements in a crowd; the graph holds one version cell above a line like this, none inside it. Rows entering or leaving only mark the tree stale, and it is rebuilt once at the first question after, so a burst of insertions costs one rebuild rather than one per batch. Born as the winning third subject of `demo:list`, where the graph-cell layout of the same line lost every scene.

**`src/weft/rel/` — the relational layer.** A derived collection as data rather than a closure: a tree of nodes — `source`, `pure`, `filter`, `join`, `agg`, `union`, `expand`, the seven-operation algebra of the language corpus — where every operation carries its own derivative, so an edit costs the edit: a filtered change costs the change, a join edit costs its partners, a fold edit recounts its group or runs its accumulator, never the collection. Expressions inside the attributes are data too, so a whole tree serialises, hashes canonically and runs against another implementation — `test/weft/rel/corpus/` holds scenario files, frozen by the naive recount, that the future Go engine must pass verbatim; a closure may stand anywhere an expression can, and the tree then honestly loses its canon. The working surface is the typed builder behind the layer's own door, `#weft/rel`: `from<Order>('orders', 'id').where('sum', '>', 10).join(...).groupBy(...)` — field names are literal types, a comparison checks against the field's type, `keeping: true` types the alias as nullable, folds are declared through a toolkit callback, and `.live(sources)` lands the tree on an ordinary engine table, so views, folds and subscribers work on it unchanged and demand flows through: sources feed on the first look and rest after. Every relation answers `why(key)` — the source rows a row came from, found by descent when asked and stored nowhere.

Eight operations now, the eighth being `scan`: an ordered pass carrying a running total, which is what a virtualised list asks — where does a row start, and which row is at a pixel. Its plan has two axes, both announced through `onScanPlan`: the carrier (a flat prefix line of plain numbers, or an honest recount of the tail) and the form — whether the carry is written into every row or answered on demand through the relation's `order` view. Naming no carry field asks for the second, and past a few thousand rows the plan takes a named one back, because a stored carry rewrites the tail on every edit. That difference is measured in `demo:list`: the same scene ran 1680 ms stored and 0.35 ms asked.

A comparison may hold a cell instead of a value — `where('title', 'has', searchText)` — and the tree keeps a named hole where the value goes, so it stays one serialisable value while the search box drives it; substitution and a rebuild follow a change, and subscribers still hear only the difference.

**`src/weft/core/keep/keep.ts`, `store.ts`, `idb.ts` — persistence.** Only stored cells are kept; a formula is recomputed, never restored. What is written carries the moment it arrived and a schema version, so an answer that survives a reload is honest about its age. Another version is dropped unless a `migrate` rescues it; anything past `maxAge` is dropped; rubbish on disk is dropped rather than thrown. The store is asynchronous because a worker has no synchronous one: `idbStore` opens lazily at the current version, survives another tab's upgrade, and commits explicitly. `bestStore(name)` takes the database where there is one and memory where there is not — and says which it took, so nothing quietly keeps a book that dies with the tab. Restoring never delays the first paint, and an edit or an answer that beat the disk wins over what the disk held. A failed write is a declared state — `saving` says ok, or gives the reason — not silence.

**`src/weft/core/keep/outbox.ts` — the outbox.** A command that reached for the world is written down before it is sent and leaves the book only when the world confirms it, so a tab dying mid-flight loses nothing. Each entry carries an idempotency key — the same one on every attempt, including after a reload — which is what makes a repeat safe rather than a second purchase. Entries go one at a time in the order they were written. A permanent refusal withdraws the entry at once and hands it to `onRefused` with the last error: nothing dies quietly. An unknown outcome does not count towards poison, so a blinking network does not bury live entries. Past `maxAttempts` an entry sticks and waits for a person; `again(id)` and `forget(id)` are the two doors, and both leave a trace. With `retain`, a confirmed entry stays in the book as done until `absorb(before)` takes it — which is what lets an overlay survive the gap between confirmation and the next snapshot.

**`src/weft/core/table/project.ts`, `arrange.ts` — base and overlay.** `projected(base, book, {apply})` replays the book over the truth in queue order; a refusal rolls nothing back, because the entry simply is not there any more and the projection is recomputed. `preserve` restores identity — the same piece is the same object, recursively — so memoised screens and equality gates keep working through replays and reloads. `Lanes` with `lanePlace` / `laneDrop` / `laneAppend` / `laneFind` is the vocabulary of arrangement: absolute, total, void without a subject and idempotent by construction, rather than by the discipline of whoever writes the rules.

**`src/weft/core/graph/region.ts` — lifetime.** `region(name, build)` owns everything created while it builds — cells, watches, timers, sources — and puts it out in one move, in reverse order of birth, with names nesting for debugging. Each primitive knows its own teardown: a source stops its clock and disowns its flight, a book keeps its entries whole.

**`src/weft/core/graph/waves.ts`, `journal.ts` — observation.** A wave is the natural unit of the graph's work: a batch of writes into inputs, the recomputations it causes, the gates where it died, the watchers it woke. A wave follows a write; a read is a question, not a wave. The probe costs one null check while it is off. The journal answers both questions a debugger owes — why did this recompute (a trace back along the edges to the writes) and why did this _not_ update (the gate where the wave stopped) — and `replay` is a time machine over inputs, honest about its border: what formulas derive is rebuilt, what lives outside the graph is not. `trace(node)` looks without touching.

**`src/weft/core/remote/reconcile.ts` — reconciliation.** Something outside must match a value inside: request headers match the identity, a socket subscription matches the row on show. The rule is to watch the value itself rather than the events that might have changed it — then there is no list of triggers, and nothing to go stale when a fourth thing starts feeding that value. Following is cold by default. While one value is being applied a newer one supersedes the ones between, because the world was never in those states.

**`src/weft/link/` — placement.** The graph is meant to live in a worker, so the boundary is designed for rather than retrofitted. A `Channel` is two functions — send and listen; `serve(surface, channel)` publishes named cells, keyed families, commands and declared facts from the graph's side; `link(channel)` gives the watching side mirrors and command handles. A mirrored cell is an ordinary stored cell holding the same `Remote` shape a source does — one vocabulary on both sides of the wire — and its single writer is the wire, so **demand crosses the boundary by itself**. Changes are coalesced per cell and flushed on a schedule you pass in — once a frame in a browser, at once in tests — and the frame races a timer, because a background tab's frame never arrives at all.

Two more arrangements come with it. `busHub(name)` and `busChannel(name)` put the graph in one tab and watchers in the others over a `BroadcastChannel`; because a bus carries everything to everybody, the envelope says who a message is from and for, and the hub hands each tab a channel of its own. `sharedWorkerHub(self)` and `sharedWorkerChannel(port)` are the same shape for a shared worker. Where shared workers are missing, `leadOrFollow` decides which tab holds the graph by holding a lock: a tab follows at once and takes over the moment the lock comes to it, which in a browser is the moment the leading tab dies. The lock is passed in rather than reached for, so it is testable without a browser.

The graph announces itself when it starts, and a watcher asks again for everything it still watches — a worker restart or a change of leader costs a round trip, not a stale screen. A tab that dies cannot say goodbye, so both hubs hold each tab by a lease that anything it says renews, while the tab keeps a heartbeat with a fast introduction. An idle mirror is let go after `linger`, but its handle stays alive: the next look re-registers the very same mirror. And a call still waiting when the graph restarts, or when the link closes, is rejected with `Unknown` rather than an ordinary error — the other side may have done the work, and pretending it refused would license a retry that is only safe if the command is.

`pairInMemory()` is the two ends in one process, cloning messages on the way exactly as a real boundary would, so a value that could not survive the crossing fails in the tests rather than in the browser. `portChannel(port)` covers a browser worker or any message port; the suite runs the whole protocol over a real `MessageChannel` as well as in memory.

**`src/loom/` — the convenient layer.** A handful of words over the engine: `fact` (the door for what the person states), `truth` and `truthBy` (the door for what the world answers — read as a plain value, with flight, fault and asked standing beside it), `feed` (the door for what the world keeps changing: a collection fed by deltas, fed on the first look and resting when nobody watches), `will` (the door for intent: a typed dictionary of senders over the book), `view` (a formula), `laid` (the picture — truth plus the replay of the book). `useLive` and `useField` are its seam; `offer`, `adopt` and `carry` are the carrier, which decides where the station lives — inline, or in a leading tab with the others mirroring — without the dialect noticing. It is documented on its own; here it is enough to say that it imports the engine and the engine knows nothing about it.

**`src/weft-react` — native hooks,** a unit of its own for whoever takes the engine directly: `useCell`, `useCommand`, `useSource`, `useInputBinding`, `useSourceValue`, and `useKeepRow` — which holds the row a reader is looking at in place while a live list grows above it. Deliberately thin, imports the engine only through its front door. Loom takes `useField` from here rather than rewriting the mechanics; the convenient layer's own seam is `src/loom/react.ts`.

## Where it stands

The engine is built: graph, commands, families, remote state, sources with demand-driven delivery and policies, parametric queries, live tables, a relational layer with a typed builder and a cross-implementation corpus, persistence on IndexedDB, an outbox with keys and doors, projection and arrangement, regions, waves and a journal, the wire with leases and leadership — and the dialect on top of it. 363 tests, no build step, no runtime dependencies. `src/weft/index.ts` is the front door (the relational layer keeps a door of its own, `#weft/rel`, so the main surface does not grow); React does not exist in the engine: native hooks live behind `#weft-react`, the convenient layer behind `#loom`.

**Engines.** A graph is owned as a value: `graph(name)` gives one with its own propagation, regions, probe and end of life, and every node carries its engine from birth — so watching, subscribing and tracing never have to be told which graph is meant. One isolate can therefore hold several: a leading tab or a shared worker serving people who are not each other's, a widget embedded in a host page that has no graph of its own, a session ending and another beginning in the same tab. Reading across engines is refused by name rather than stitched silently; the one door between them is `adopt`, which carries a value in and demand out, readable and never writable. Applications with a single graph never learn any of this: the bare `input`/`cell`/`watch` build in the root engine exactly as before, and only go quiet — loudly — once a second engine is alive and building without saying where would be ambiguous. Nodes are recognised by a registered mark rather than by class, so two copies of the library on one page still know a node when they see one. The engine costs nothing measurable: on build, cold read, writes, fan-out and batching the numbers sit within noise of the module-level graph it replaced.

**Failures have a border.** A formula that throws leaves its cell in a state with a name — held, rethrown on the next read rather than run again, so a formula that fails always fails once rather than once per reader. Its links stay live, which is the way back: when a source moves the formula runs again, and a recovery is heard by whoever reads the cell, exactly like an ordinary change. A round of watchers is carried to its end even when one of them throws — the queue is emptied before the round begins, so stopping at the first fall used to lose everyone behind it. What fell is collected and handed to the engine's `onError`; without one, the first failure is thrown after the round rather than instead of it. Failures are named in the wave, so the journal answers "what broke here" the way it answers "why did this not update".

**Sessions have a border too.** Kept things live under an application and a session: `within(store, app, session)` scopes the keys, so two people in one browser — a leading tab serving both, or one after the other in the same tab — never read each other's. Inside a scope there are two kinds of key: a cache, which can be fetched again, and a book, which the person entrusted to us and which has not been sent yet. Logging out wipes the cache and leaves the book; what belongs to nobody is not touched at all. On the wire a tab says whose it is when it says hello, and a station holding one household refuses another's by name rather than in silence — a quiet wire looks like a fault, a refusal looks like what it is.

**The library is a stack of blocks.** Bottom to top: data (keys, structural sharing, arrangement), graph (cells, engines, regions, waves, journal), remote (the shape of an answer from elsewhere, sources, queries), keep (disk, kept values, the outbox and the projection over it), table (rows, views, folds, carriers, the planner), rel (nodes as data, runners, the builder), link (channels, serving, mirrors, buses, leadership), the front door, the React seam, and the Loom dialect. A block reaches downwards only, and never through the front door to get at a neighbour. This is checked by a test that reads every import in `src`, not by good intentions: `test/weft/blocks.test.ts` holds the stack as a list and names the file and the rule when one is broken.

**Carriers are chosen, not hardcoded.** A fold has one answer and several ways to keep it — a running accumulator, an honest recount, a tree of block partials — differing in who pays for one edit and in nothing else. Traits are gathered from the collection, a pure function decides, and a factory builds the carrier behind one interface; the planner is tested without a single cell and the carriers as arithmetic, against one suite run for all of them. The choice is also revisited as the collection grows: a table usually starts empty, and the fold built over nothing deserves the carrier it would be given at its present size — the check is a comparison against a threshold rather than a planning run, a swap costs one rebuild, and a collection sitting on the threshold is kept from oscillating by requiring a clear margin on the way back down. Every decision, first or later, is announced through `onPlan`. A carrier named by hand in the fold's passport is never taken away.

What is not done, and should be said plainly. No live application has been moved onto this yet — the demos are stands, and the honest next step is one domain of a real product, whole.

## What the library asks of values

The graph does not know what is in a cell, and does not want to. What it does rely on, stated plainly:

**A formula is pure and settled.** Given the same inputs it gives the same result, and it reaches for nothing else — no clock, no random, no fetch. A formula that reads the time is a formula whose value is wrong the moment it is cached.

**Equality is a real equivalence relation.** Propagation stops where a recomputed value equals the old one, so `equal` decides what the rest of the system believes. The default is `Object.is`, which is right for numbers, strings and shared objects, and wrong for a value rebuilt on every run — pass an `equal` that compares content, or the wave never dies. (`0` and `-0` are different under `Object.is`; a formula flipping between them wakes watchers for nothing.)

**Anything recomputed in pieces must be exact and associative in its own type.** A block-wise total is only the same number as a left-to-right total if addition is associative, and floating point's is not. That is why the demo carries its own decimal arithmetic (`demo/common/dec.ts`, a count of millionths in an integer), and why in Warp the decimal types are the floor while binary floats are for physics rather than for anything the engine reassembles.

**Anything crossing a thread boundary must survive structural cloning.** No classes with methods, no functions inside values.

## Two spreadsheets

`demo/` holds the same spreadsheet twice: `spreadsheet/` keeps its state by hand, `spreadsheet-weft/` keeps it on this library. The grid, the formula language, the sample sheet and the instrumentation are shared in `demo/common/`, so what differs is only who keeps the values.

The hand-written one needs 175 lines for that — a 146-line store and a 29-line dependency scan it cannot do without: a store of texts, what each cell reads and who reads it kept in both directions, the transitive stain of a change, Kahn's order over it, a loop search for whatever the order leaves out, and a subscription per cell. The one on this library needs 99, and none of those words appear in it — a cell's text is an `input`, its value is a `family` member whose formula reads its neighbours, and reading is what records the dependency. A loop is not searched for: reading a cell that is busy computing throws, and that becomes `#CYCLE!`.

Both pass the same seven questions (`store.test.ts`, `sheet.test.ts`) — the same values, the same cells told, the same recovery when a loop is cut. What differs is the bill. On a sheet of 26,000 cells with 780 on screen, measured by `pnpm demo:bench`:

```
                    open   first look   edit A1   worked out   renders   vs classic
classic           112 ms       0.3 ms    4.7 ms          242        53         1.0x
weft, no blocks   6.5 ms       3.8 ms    0.3 ms           84        53        13.6x
weft, blocks      5.8 ms       4.1 ms    0.4 ms           84        53        11.7x
```

Better than ten times cheaper per edit, and the gap widens with the sheet. Blocks make no difference in this scene and are not meant to: nothing on screen sums a column. The reason is not a faster engine — it is that the hand-written sheet works out every cell whether anyone is looking or not, while demand decides here. The same 53 components render in both — the `renders` column is the React render count taken without React, since one shown cell is watched by exactly one component — and that is the point: same behaviour, different price, much less written down.

Run it yourself rather than trusting the figures — they are one machine's, and the ratios are what matter. Ratios move with the machine and the runtime: what has held everywhere is the shape — an edit an order of magnitude cheaper, a first look that costs more because it is where the work moved to.

## Blocks

`src/weft/core/table/blocks.ts` answers a long total from a tree of partial sums rather than by reading every cell: blocks of `span`, blocks of blocks above them, each partial an ordinary cell. `blocks({ read, zero, join })` is the whole surface — the caller supplies the arithmetic and owes it associativity and exactness; the spreadsheet builds one tree per fold and direction and cuts a rectangle into lines. One edit then touches one partial per level and the total. Trees run both ways — down a column and along a row — and a rectangle is cut into lines along its longer side, since that is the side a tree pays on.

It is worth building here and nowhere else. Each partial is a cell, so what depends on what — and what has to be redone — is the graph's business; the hand-written sheet could keep the same tree, but would have to invalidate it level by level, by hand. And it is only correct because the arithmetic underneath is exact.

Measured with the totals row on screen, so the long column sums are live — the bench's second scene, a run of its own (so the classic row differs from the table above). Both tables are one machine, median of three, with one run thrown away first — subjects are measured in order, and whoever goes first otherwise pays for warming the runtime up; that bias turned out to be worth more than everything the tables compare:

```
                    open   first look   edit A1   worked out   renders   vs classic
classic           107 ms       0.3 ms    4.3 ms          242        67         1.0x
weft, no blocks   8.7 ms      82.1 ms    8.4 ms          240        67         0.5x
weft, blocks      3.7 ms       105 ms    2.0 ms          257        67         2.2x
```

Two honest things in that table. The middle row shows what blocks are for: without them every edit re-reads whole columns (8.4ms, half the hand-written sheet's speed), with them the same answer costs four times less (2.0ms) and the multiple grows with the column.

The first look is where demand shows its bill rather than its saving: 105ms against the hand-written sheet's 0.3ms. Nothing is lost there, it is moved. The hand-written sheet works out all 26 column sums while opening — that is its 107ms — so it has nothing left to do when the screen appears; here almost nothing happens at open (3.7ms) and the first total reads every cell it covers at the moment somebody looks. Open plus first look comes to roughly the same on both sides. What differs is that a sheet opened without totals on screen never pays it at all — scene one, where the first look costs 4ms — and that every edit afterwards is twice as cheap.

Measurement earned that paragraph the hard way: the block tree was suspected of costing the first look, and measuring said otherwise. Building the answer as a tree is not more expensive than one straight pass — it is cheaper, because a single total reading 26,000 cells pays for a dependency list 26,000 long, and a tree breaks it up. The first look costs what it costs because 16,010 formulas have to be worked out, and both sheets pay that; only the moment differs.

Chasing that middle row also found a real fault in the library: `family` reordered its LRU on every read — a map delete and insert per lookup — which is pure cost while the ceiling is far away. Reordering now happens only as the ceiling comes into sight, and the same scene went from 95ms to 16ms.

## The other stands

`demo/kanban-classic` and `demo/kanban-weft` are the same board twice: Redux with redux-observable, reselect and hand-written optimism against the dialect over this engine — same server, same screen, same six trials. The trials are written once (`demo/kanban-weft/suite.ts`) and run twice: in place, and through a mirror against a station across a cloning channel, so the carrier has to prove that placement changes nothing. `demo/kanban-tabs` is that board carried — several tabs on one state, the leader elected by a lock, the book surviving succession. `demo/rail` is pages plus a live ticker: a table fed by deltas, shelves by status, a virtual window that holds the row you are looking at (`useKeepRow`, now library code), search with `calm`, and two services reduced into one outcome. The engine's own multi-window wiring — hubs, leases, leadership without the convenient layer — is documented by its tests, `test/weft/link/tabs.test.ts`.

## One package

The library, its tests and the demos are a single package with one `tsconfig.json` and one set of scripts. Nothing crosses a package boundary, so nothing has to be kept in step: no workspace, no alias table, no second compiler config.

Three units, three folders, one door each — and one law: **across a unit's boundary, only through the front door**. `src/weft-react` imports nothing but `#weft`; `src/loom` imports nothing but `#weft` and `#weft-react`; the engine's internals (`#weft/core/…`, `#weft/link/…`) are reachable only from the engine itself and its tests. The law is held by grep, not discipline: `#weft/core` outside `src/weft` and `test/weft` finds nobody, `react` inside `src/weft` finds nothing. Tests are laid out by unit — `test/weft`, `test/weft-react`, `test/loom` — and each stand keeps its own tests beside it. The future package split is these same folders under other names.

```json
"imports": {
  "#weft": "./src/weft/index.ts",
  "#weft/rel": "./src/weft/rel/index.ts",
  "#weft/*": "./src/weft/*",
  "#weft-react": "./src/weft-react/index.ts",
  "#loom": "./src/loom/index.ts",
  "#loom/react": "./src/loom/react.ts"
}
```

`import { cell } from '#weft/core/graph.ts'` inside the engine, `import { input, family } from '#weft'` from a stand that works it, `import { fact, truth, will } from '#loom'` from one on the convenient layer — resolved by Node itself, understood by the compiler under `nodenext`, and understood by Vite. There is no `paths` mapping and no bundler alias to drift.

## Running it

```
pnpm test            # everything in one run
pnpm test:weft       # the engine
pnpm test:weft-react # the native hooks and their render lane
pnpm test:loom       # the convenient layer and its render lane
pnpm test:stands     # the demos
pnpm check         # types, including the Vite config
pnpm lint          # oxlint
pnpm format        # oxfmt, in place (format:check to only look)
pnpm demo          # every stand behind one menu
pnpm demo:build    # then demo:preview to serve what was built
pnpm demo:bench    # the two sheets measured against each other, without React
```

Node 26 strips types on its own, so there is no build step for the library or its tests; Vite is only there for the demos. The render lane runs in the same runner: happy-dom registered once at the top of the file, React under `act`, no second framework.

Names in prose are capitalised — Warp, Weft, Loom; in code, paths and packages they stay lowercase — `weft`, `loom`, `@textrinum/weft`.
