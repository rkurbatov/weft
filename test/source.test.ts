import { test } from "node:test";
import assert from "node:assert/strict";
import { cell, subscribe } from "#core/graph.ts";
import { source } from "#core/source.ts";
import { valueOf } from "#core/remote.ts";
import type { Timers } from "#core/source.ts";

/** A clock and a timer queue the test drives by hand. */
function fakeWorld() {
  let time = 1000;
  let next = 1;
  const jobs = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    set: (fn, ms) => {
      const id = next++;
      jobs.set(id, { at: time + ms, fn });
      return id;
    },
    clear: (handle) => {
      jobs.delete(handle as number);
    },
  };
  return {
    timers,
    now: () => time,
    pending: () => jobs.size,
    /** Move time forward, firing whatever comes due. */
    async advance(ms: number) {
      const until = time + ms;
      for (;;) {
        const due = [...jobs.entries()]
          .filter(([, job]) => job.at <= until)
          .toSorted((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        const [id, job] = due;
        jobs.delete(id);
        time = job.at;
        job.fn();
        await settle();
      }
      time = until;
      await settle();
    },
  };
}

/** Let promise callbacks run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("no demand, no delivery", async () => {
  const world = fakeWorld();
  let calls = 0;
  const feed = source(
    async () => {
      calls++;
      return 1;
    },
    { now: world.now, timers: world.timers },
  );
  feed.state.peek();
  const derived = cell(() => valueOf(feed.state.get()));
  derived.peek(); // computed on request; nobody live behind it
  await settle();
  assert.equal(calls, 0);
  assert.equal(feed.state.peek().kind, "empty");
});

test("the first watcher starts it: empty, in flight, value", async () => {
  const world = fakeWorld();
  const feed = source(async () => "v", { now: world.now, timers: world.timers });
  const seen: string[] = [];
  const stop = subscribe(feed.state, (s) => seen.push(s.kind));
  assert.equal(feed.state.peek().kind, "loading");
  await settle();
  assert.deepEqual(seen, ["loading", "value"]);
  const held = feed.state.peek();
  assert.equal(held.kind === "value" ? held.value : undefined, "v");
  assert.equal(held.kind === "value" ? held.at : 0, 1000);
  stop();
});

test("it polls while watched and stops when the last watcher goes", async () => {
  const world = fakeWorld();
  let calls = 0;
  const feed = source(async () => ++calls, { every: 100, now: world.now, timers: world.timers });
  const stop = subscribe(feed.state, () => {});
  await settle();
  assert.equal(calls, 1);
  await world.advance(250);
  assert.equal(calls, 3);
  stop();
  assert.equal(world.pending(), 0);
  await world.advance(500);
  assert.equal(calls, 3);
});

test("within shelf life a new watcher reuses the answer; past it, a refetch", async () => {
  const world = fakeWorld();
  let calls = 0;
  const feed = source(async () => ++calls, {
    shelfLife: 500,
    now: world.now,
    timers: world.timers,
  });
  const first = subscribe(feed.state, () => {});
  await settle();
  assert.equal(calls, 1);
  first();
  await world.advance(100);
  const second = subscribe(feed.state, () => {});
  await settle();
  assert.equal(calls, 1); // still good
  second();
  await world.advance(600);
  const third = subscribe(feed.state, () => {});
  await settle();
  assert.equal(calls, 2); // gone off
  third();
});

test("a value is kept through the next flight, so screens do not blank", async () => {
  const world = fakeWorld();
  let calls = 0;
  const feed = source(async () => `answer ${++calls}`, {
    every: 100,
    now: world.now,
    timers: world.timers,
  });
  const stop = subscribe(feed.state, () => {});
  await settle();
  assert.equal(valueOf(feed.state.peek()), "answer 1");
  await world.advance(100);
  assert.equal(calls, 2);
  assert.equal(valueOf(feed.state.peek()), "answer 2");
  stop();
});

test("refusal is a state, and it retries with growing waits", async () => {
  const world = fakeWorld();
  let calls = 0;
  const feed = source(
    async () => {
      calls++;
      if (calls < 3) throw new Error(`no ${calls}`);
      return "finally";
    },
    { retry: 100, now: world.now, timers: world.timers },
  );
  const stop = subscribe(feed.state, () => {});
  await settle();
  const first = feed.state.peek();
  assert.equal(first.kind, "failed");
  assert.equal(first.kind === "failed" ? first.attempt : 0, 1);
  await world.advance(100);
  assert.equal(calls, 2);
  await world.advance(150); // second wait is 200, not yet
  assert.equal(calls, 2);
  await world.advance(100);
  assert.equal(calls, 3);
  assert.equal(valueOf(feed.state.peek()), "finally");
  stop();
});

test("a refusal keeps the previous value beside it", async () => {
  const world = fakeWorld();
  let calls = 0;
  const feed = source(
    async () => {
      calls++;
      if (calls === 2) throw new Error("flaky");
      return `answer ${calls}`;
    },
    { every: 100, now: world.now, timers: world.timers },
  );
  const stop = subscribe(feed.state, () => {});
  await settle();
  await world.advance(100);
  const state = feed.state.peek();
  assert.equal(state.kind, "failed");
  assert.equal(valueOf(state), "answer 1");
  stop();
});

test("refresh asks now, even unwatched", async () => {
  const world = fakeWorld();
  let calls = 0;
  const feed = source(async () => ++calls, { now: world.now, timers: world.timers });
  await feed.refresh();
  assert.equal(calls, 1);
  assert.equal(valueOf(feed.state.peek()), 1);
  assert.equal(feed.demanded, false);
});

test("a second demand rides the flight already under way", async () => {
  const world = fakeWorld();
  const gates: Array<(v: string) => void> = [];
  const feed = source(() => new Promise<string>((resolve) => gates.push(resolve)), {
    now: world.now,
    timers: world.timers,
  });
  const stop = subscribe(feed.state, () => {});
  await settle();
  stop();
  const second = subscribe(feed.state, () => {});
  await settle();
  assert.equal(gates.length, 1); // one request, not two
  gates[0]?.("v");
  await settle();
  assert.equal(valueOf(feed.state.peek()), "v");
  second();
});

test("a forced refresh disowns the older answer", async () => {
  const world = fakeWorld();
  const gates: Array<(v: string) => void> = [];
  const feed = source(() => new Promise<string>((resolve) => gates.push(resolve)), {
    now: world.now,
    timers: world.timers,
  });
  const stop = subscribe(feed.state, () => {});
  await settle();
  void feed.refresh({ force: true });
  await settle();
  assert.equal(gates.length, 2);
  gates[1]?.("fresh");
  await settle();
  gates[0]?.("stale");
  await settle();
  assert.equal(valueOf(feed.state.peek()), "fresh");
  stop();
});

test("a formula over a source sees only its own value change", async () => {
  const world = fakeWorld();
  let calls = 0;
  const feed = source(async () => ({ id: 1, hits: ++calls }), {
    every: 100,
    now: world.now,
    timers: world.timers,
  });
  const id = cell(() => valueOf(feed.state.get())?.id);
  let woke = 0;
  const stop = subscribe(id, () => woke++);
  await settle();
  assert.equal(woke, 1); // nothing -> 1, the only real change
  await world.advance(300);
  assert.ok(calls >= 3, `calls ${calls}`);
  assert.equal(woke, 1); // hits kept changing; id did not
  assert.equal(id.peek(), 1);
  stop();
});
