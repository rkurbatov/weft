// Cell graph: stored cells (one writer each), derived cells (formulas),
// watchers. Dependencies are discovered by reading, never declared.
//
// Demand is counted alongside the links: a source knows whether any live
// watcher depends on it, which is how adapters learn when to start and stop.

export type Equal<T> = (a: T, b: T) => boolean;

/** Node states. CHECK means "an ancestor may have changed" — resolved by walking up. */
const CLEAN = 0;
const CHECK = 1;
const DIRTY = 2;

type State = typeof CLEAN | typeof CHECK | typeof DIRTY;

interface Source {
  readonly observers: Set<Consumer>;
  readonly demand: number;
  /** Bring own value up to date. Stored cells are always current. */
  stabilize(): void;
  /** Called by the graph when the number of demanding paths changes. */
  demandChanged(delta: number): void;
}

interface Consumer {
  state: State;
  readonly sources: Set<Source>;
  readonly observers: Set<Consumer>;
  /** 1 if links made by this consumer carry demand upward, 0 otherwise. */
  contribution(): number;
  stabilize(): void;
}

let active: Consumer | null = null;
let tracking: Set<Source> | null = null;
let batchDepth = 0;
let workDepth = 0;
const pending = new Set<Watcher>();
const notices: Array<() => void> = [];

/**
 * Source lifecycle hooks run after the graph is quiet, never inside a formula:
 * an adapter is free to write its own cell from them.
 */
function notice(fn: () => void): void {
  notices.push(fn);
  if (workDepth === 0) drain();
}

function drain(): void {
  while (notices.length > 0) {
    const fn = notices.shift();
    if (fn !== undefined) fn();
  }
}

function enter(): void {
  workDepth++;
}

function leave(): void {
  workDepth--;
  if (workDepth === 0) drain();
}

function track(source: Source): void {
  const consumer = active;
  if (consumer === null) return;
  if (consumer.sources.has(source)) return;
  consumer.sources.add(source);
  // A link that survives a recompute keeps its observer slot and its demand.
  if (tracking !== null && tracking.delete(source)) return;
  source.observers.add(consumer);
  const carried = consumer.contribution();
  if (carried > 0) source.demandChanged(carried);
}

/** Direct source changed: consumer must recompute. */
function markDirty(node: Consumer): void {
  if (node instanceof Watcher) {
    // Always queue: a watcher marked while it runs must still be woken.
    node.state = DIRTY;
    pending.add(node);
    return;
  }
  if (node.state === DIRTY) return;
  node.state = DIRTY;
  for (const o of node.observers) markCheck(o);
}

/** Something upstream changed: consumer must verify before trusting its value. */
function markCheck(node: Consumer): void {
  if (node instanceof Watcher) {
    if (node.state === CLEAN) node.state = CHECK;
    pending.add(node);
    return;
  }
  if (node.state !== CLEAN) return;
  node.state = CHECK;
  for (const o of node.observers) markCheck(o);
}

/** Resolve CHECK by stabilizing sources; a changed source flips us to DIRTY. */
function verify(node: Consumer): boolean {
  for (const s of node.sources) {
    s.stabilize();
    if (node.state === DIRTY) return true;
  }
  return false;
}

function detach(node: Consumer, sources: Iterable<Source>): void {
  const carried = node.contribution();
  for (const s of sources) {
    s.observers.delete(node);
    if (carried > 0) s.demandChanged(-carried);
  }
}

function unlink(node: Consumer): void {
  detach(node, node.sources);
  node.sources.clear();
}

/** Run a formula or a watcher body, keeping links that it reads again. */
function retrack(node: Consumer, body: () => void): void {
  const prevActive = active;
  const prevTracking = tracking;
  const previous = new Set(node.sources);
  node.sources.clear();
  active = node;
  tracking = previous;
  try {
    body();
  } finally {
    active = prevActive;
    tracking = prevTracking;
    // Whatever was not read again is no longer a dependency.
    detach(node, previous);
  }
}

function flush(): void {
  if (batchDepth > 0) return;
  enter();
  try {
    // Watchers may write, queueing more watchers; drain until quiet.
    let guard = 0;
    while (pending.size > 0) {
      if (++guard > 1000) throw new Error("weft: propagation did not settle");
      const round = [...pending];
      pending.clear();
      for (const w of round) w.stabilize();
    }
  } finally {
    leave();
  }
}

/** Group writes so watchers see one settled picture. */
export function batch<T>(fn: () => T): T {
  batchDepth++;
  enter();
  try {
    return fn();
  } finally {
    batchDepth--;
    try {
      flush();
    } finally {
      leave();
    }
  }
}

/** Read without becoming dependent on it. */
export function untracked<T>(fn: () => T): T {
  const prevActive = active;
  const prevTracking = tracking;
  active = null;
  tracking = null;
  try {
    return fn();
  } finally {
    active = prevActive;
    tracking = prevTracking;
  }
}

export interface CellOptions<T> {
  equal?: Equal<T>;
  name?: string;
}

export interface InputOptions<T> extends CellOptions<T> {
  /** First live watcher arrived. Runs outside any formula. */
  onDemand?: () => void;
  /** Last live watcher left. Runs outside any formula. */
  onIdle?: () => void;
}

/** Stored cell: the only thing that can be written, by its single writer. */
export class Input<T> implements Source {
  readonly observers = new Set<Consumer>();
  readonly name: string;
  demand = 0;
  private current: T;
  private readonly equal: Equal<T>;
  private readonly onDemand: (() => void) | undefined;
  private readonly onIdle: (() => void) | undefined;

  constructor(initial: T, options: InputOptions<T> = {}) {
    this.current = initial;
    this.equal = options.equal ?? Object.is;
    this.name = options.name ?? "input";
    this.onDemand = options.onDemand;
    this.onIdle = options.onIdle;
  }

  stabilize(): void {}

  demandChanged(delta: number): void {
    const before = this.demand;
    this.demand += delta;
    if (before === 0 && this.demand > 0 && this.onDemand !== undefined) notice(this.onDemand);
    else if (before > 0 && this.demand === 0 && this.onIdle !== undefined) notice(this.onIdle);
  }

  /** Somebody live depends on this cell right now. */
  get demanded(): boolean {
    return this.demand > 0;
  }

  get(): T {
    track(this);
    return this.current;
  }

  peek(): T {
    return this.current;
  }

  set(next: T): void {
    if (this.equal(this.current, next)) return;
    this.current = next;
    enter();
    try {
      for (const o of this.observers) markDirty(o);
      flush();
    } finally {
      leave();
    }
  }

  update(fn: (prev: T) => T): void {
    this.set(fn(this.current));
  }
}

/** Derived cell: a formula. Nobody writes it; it recomputes when its inputs move. */
export class Cell<T> implements Source, Consumer {
  state: State = DIRTY;
  readonly sources = new Set<Source>();
  readonly observers = new Set<Consumer>();
  readonly name: string;
  demand = 0;
  private value!: T;
  private valued = false;
  private computing = false;
  private readonly formula: () => T;
  private readonly equal: Equal<T>;

  constructor(formula: () => T, options: CellOptions<T> = {}) {
    this.formula = formula;
    this.equal = options.equal ?? Object.is;
    this.name = options.name ?? "cell";
  }

  contribution(): number {
    return this.demand > 0 ? 1 : 0;
  }

  demandChanged(delta: number): void {
    const before = this.demand;
    this.demand += delta;
    if (before === 0 && this.demand > 0) {
      for (const s of this.sources) s.demandChanged(1);
    } else if (before > 0 && this.demand === 0) {
      for (const s of this.sources) s.demandChanged(-1);
    }
  }

  get(): T {
    track(this);
    this.stabilize();
    return this.value;
  }

  peek(): T {
    return untracked(() => this.get());
  }

  /** Somebody downstream is reading this cell right now. */
  get observed(): boolean {
    return this.observers.size > 0;
  }

  /** Somebody live depends on this cell right now. */
  get demanded(): boolean {
    return this.demand > 0;
  }

  /** Let go of the sources. Next read recomputes from scratch. */
  dispose(): void {
    if (this.computing)
      throw new Error(`weft: cannot dispose cell "${this.name}" while it computes`);
    unlink(this);
    this.state = DIRTY;
    this.valued = false;
  }

  stabilize(): void {
    if (this.state === CLEAN) return;
    if (this.computing) throw new Error(`weft: cycle through cell "${this.name}"`);
    if (this.state === CHECK && !verify(this)) {
      this.state = CLEAN;
      return;
    }
    this.recompute();
  }

  private recompute(): void {
    enter();
    try {
      let next!: T;
      this.computing = true;
      try {
        retrack(this, () => {
          next = this.formula();
        });
      } finally {
        this.computing = false;
      }
      // A first value is not a change: nobody held a previous one from us.
      const changed = this.valued && !this.equal(this.value, next);
      this.value = next;
      this.valued = true;
      this.state = CLEAN;
      // Equal result stops here: observers stay CHECK and settle without recomputing.
      if (changed) for (const o of this.observers) markDirty(o);
    } finally {
      // Source hooks queued during the run fire here — value in place, state settled.
      leave();
    }
  }
}

/** Watcher: leaf of the graph. Runs its body, then reruns it when what it read moves. */
export interface WatchOptions {
  /**
   * Whether watching counts as asking. A cold watcher (`demand: false`) sees the
   * changes that happen anyway but causes no work of its own — that is what
   * persistence and logging want.
   */
  demand?: boolean;
}

export class Watcher implements Consumer {
  state: State = DIRTY;
  readonly sources = new Set<Source>();
  readonly observers = new Set<Consumer>();
  private disposed = false;
  private readonly body: () => void;
  private readonly demanding: boolean;

  constructor(body: () => void, options: WatchOptions = {}) {
    this.body = body;
    this.demanding = options.demand ?? true;
    this.run();
  }

  contribution(): number {
    return this.disposed || !this.demanding ? 0 : 1;
  }

  stabilize(): void {
    if (this.disposed || this.state === CLEAN) return;
    if (this.state === CHECK && !verify(this)) {
      this.state = CLEAN;
      return;
    }
    this.run();
  }

  private run(): void {
    enter();
    try {
      retrack(this, this.body);
    } finally {
      this.state = CLEAN;
      leave();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    enter();
    try {
      unlink(this); // still contributing, so demand is given back before we go
      this.disposed = true;
      pending.delete(this);
    } finally {
      leave();
    }
  }
}

export function input<T>(initial: T, options?: InputOptions<T>): Input<T> {
  return new Input(initial, options);
}

export function cell<T>(formula: () => T, options?: CellOptions<T>): Cell<T> {
  return new Cell(formula, options);
}

export function watch(body: () => void, options?: WatchOptions): () => void {
  const w = new Watcher(body, options);
  return () => w.dispose();
}

export type Readable<T> = Input<T> | Cell<T>;

/** Watch one cell; the listener sees only actual changes. */
export function subscribe<T>(
  source: Readable<T>,
  listener: (value: T) => void,
  options?: WatchOptions,
): () => void {
  let first = true;
  return watch(() => {
    const value = source.get();
    if (first) {
      first = false;
      return;
    }
    untracked(() => listener(value));
  }, options);
}
