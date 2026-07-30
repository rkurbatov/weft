// A source owns delivery: fetching, retrying, polling, and its own pace.
// It runs only while somebody live is watching it — demand starts it, idleness
// stops it — so an unwatched screen costs nothing.

import { cell, input } from "./graph.ts";
import type { Readable } from "./graph.ts";
import { arrived, heldOf, loading, refused } from "./remote.ts";
import type { Remote } from "./remote.ts";

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const wallClock: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SourceOptions {
  name?: string;
  /** Ask again this often while watched. Without it, a source loads once per demand. */
  every?: number;
  /** How long an answer stays good. A new demand on a stale answer refetches. */
  shelfLife?: number;
  /** Wait before a retry; doubles per failed attempt, capped by retryCap. */
  retry?: number;
  retryCap?: number;
  /** The source will not be asked more often than this, however strict a requirement is. */
  floor?: number;
  /** Told when a requirement asks for more than the floor allows. */
  onUnmet?: (unmet: { source: string; wanted: number; floor: number }) => void;
  now?: () => number;
  timers?: Timers;
}

export interface Source<T> {
  readonly name: string;
  /** The state of what the world said: empty, in flight, value with an age, refused. */
  readonly state: Readable<Remote<T>>;
  /** Is anything live watching right now. */
  readonly demanded: boolean;
  /** How often the source is asked right now, given every live requirement. Undefined means "once per demand". */
  readonly pace: number | undefined;
  /**
   * State a requirement: this value must not be older than `within`. Held for as
   * long as the returned release is uncalled; the strictest live one sets the pace.
   */
  require(within: number): () => void;
  /**
   * Put back an answer kept from a previous run, with the moment it originally
   * arrived — so its age is honest and the usual rules decide what to do next.
   * Ignored if anything is already held or in flight.
   */
  restore(value: T, at: number): void;
  /**
   * Ask now, watched or not. Resolves when the answer has landed in the cell.
   * A flight already under way is ridden rather than duplicated; `force` starts
   * a new one and disowns the old answer.
   */
  refresh(options?: { force?: boolean }): Promise<void>;
}

export function source<T>(load: () => Promise<T>, options: SourceOptions = {}): Source<T> {
  const name = options.name ?? "source";
  const now = options.now ?? Date.now;
  const timers = options.timers ?? wallClock;
  const { every, shelfLife, retry, floor, onUnmet } = options;
  const retryCap = options.retryCap ?? (retry === undefined ? undefined : retry * 32);

  // Live requirements, one entry per consumer that stated one.
  const wants = new Map<symbol, number>();
  let timer: unknown = null;
  let generation = 0;
  let attempt = 0;
  let inFlight: Promise<void> | null = null;

  const state = input<Remote<T>>(
    { kind: "empty" },
    {
      name,
      onDemand: () => {
        reschedule();
      },
      onIdle: () => {
        cancel();
      },
    },
  );

  function cancel(): void {
    if (timer === null) return;
    timers.clear(timer);
    timer = null;
  }

  function schedule(delay: number | undefined): void {
    cancel();
    if (delay === undefined || !state.demanded) return;
    timer = timers.set(() => {
      timer = null;
      void begin();
    }, delay);
  }

  /** The strictest live requirement, if anyone stated one. */
  function strictest(): number | undefined {
    let best: number | undefined;
    for (const within of wants.values())
      best = best === undefined ? within : Math.min(best, within);
    return best;
  }

  /** How often to ask: the tightest of the declared pace and the live requirements, never below the floor. */
  function pace(): number | undefined {
    const want = strictest();
    const wanted = every === undefined ? want : want === undefined ? every : Math.min(every, want);
    if (wanted === undefined) return undefined;
    return floor === undefined ? wanted : Math.max(wanted, floor);
  }

  /** Put the next ask where the current pace and the age of what we hold say it belongs. */
  function reschedule(): void {
    if (!state.demanded) {
      cancel();
      return;
    }
    if (stale()) {
      void begin();
      return;
    }
    const interval = pace();
    if (interval === undefined) {
      cancel();
      return;
    }
    const held = heldOf(state.peek());
    const due = held === undefined ? 0 : held.at + interval - now();
    schedule(Math.max(0, due));
  }

  /** Is what we hold too old to serve the next watcher? */
  function stale(): boolean {
    const held = heldOf(state.peek());
    if (held === undefined) return true;
    const age = now() - held.at;
    const want = strictest();
    if (want !== undefined && age >= want) return true;
    if (shelfLife === undefined) return false;
    return age >= shelfLife;
  }

  function backoff(): number | undefined {
    if (retry === undefined) return undefined;
    const wait = retry * 2 ** Math.max(0, attempt - 1);
    return retryCap === undefined ? wait : Math.min(wait, retryCap);
  }

  function begin(force = false): Promise<void> {
    if (inFlight !== null && !force) return inFlight;
    cancel();
    const mine = ++generation;
    let finish!: () => void;
    const flight = new Promise<void>((resolve) => {
      finish = resolve;
    });
    // Claim the slot before touching the cell: writing it wakes watchers, and a
    // waking watcher may ask for this very source again.
    inFlight = flight;
    state.set(loading(state.peek(), now()));
    void load()
      .then(
        (value) => {
          if (mine !== generation) return;
          attempt = 0;
          state.set(arrived(value, now()));
          reschedule();
        },
        (error) => {
          if (mine !== generation) return;
          attempt++;
          state.set(refused(state.peek(), error, now(), attempt));
          schedule(backoff());
        },
      )
      .finally(() => {
        if (mine === generation) inFlight = null;
        finish();
      });
    return flight;
  }

  function require(within: number): () => void {
    if (floor !== undefined && within < floor) onUnmet?.({ source: name, wanted: within, floor });
    const token = Symbol("requirement");
    wants.set(token, within);
    reschedule();
    return () => {
      if (!wants.delete(token)) return;
      reschedule();
    };
  }

  function restore(value: T, at: number): void {
    if (inFlight !== null) return;
    if (heldOf(state.peek()) !== undefined) return;
    state.set(arrived(value, at));
  }

  return {
    name,
    state,
    require,
    restore,
    get demanded() {
      return state.demanded;
    },
    get pace() {
      return pace();
    },
    refresh: (asked = {}) => begin(asked.force ?? false),
  };
}

/**
 * A view of a source that states a requirement while anybody watches it:
 * the demand and the requirement arrive and leave together, so nothing has to
 * be released by hand.
 */
export function fresh<T>(feed: Source<T>, within: number): Readable<Remote<T>> {
  let release: (() => void) | null = null;
  const gate = input(0, {
    name: `${feed.name}!${within}`,
    onDemand: () => {
      release = feed.require(within);
    },
    onIdle: () => {
      release?.();
      release = null;
    },
  });
  return cell(
    () => {
      gate.get();
      return feed.state.get();
    },
    { name: `${feed.name}@${within}` },
  );
}
