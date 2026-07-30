// Cell graph: stored cells (one writer each), derived cells (formulas),
// watchers. Dependencies are discovered by reading, never declared.

export type Equal<T> = (a: T, b: T) => boolean

/** Node states. CHECK means "an ancestor may have changed" — resolved by walking up. */
const CLEAN = 0
const CHECK = 1
const DIRTY = 2

type State = typeof CLEAN | typeof CHECK | typeof DIRTY

interface Source {
    readonly observers: Set<Consumer>
    /** Bring own value up to date. Stored cells are always current. */
    stabilize(): void
}

interface Consumer {
    state: State
    readonly sources: Set<Source>
    readonly observers: Set<Consumer>
    stabilize(): void
}

let active: Consumer | null = null
let batchDepth = 0
const pending = new Set<Watcher>()

function track(source: Source): void {
    if (active === null) return
    active.sources.add(source)
    source.observers.add(active)
}

/** Direct source changed: consumer must recompute. */
function markDirty(node: Consumer): void {
    if (node.state === DIRTY) return
    node.state = DIRTY
    if (node instanceof Watcher) {
        pending.add(node)
        return
    }
    for (const o of node.observers) markCheck(o)
}

/** Something upstream changed: consumer must verify before trusting its value. */
function markCheck(node: Consumer): void {
    if (node.state !== CLEAN) return
    node.state = CHECK
    if (node instanceof Watcher) {
        pending.add(node)
        return
    }
    for (const o of node.observers) markCheck(o)
}

/** Resolve CHECK by stabilizing sources; a changed source flips us to DIRTY. */
function verify(node: Consumer): boolean {
    for (const s of node.sources) {
        s.stabilize()
        if (node.state === DIRTY) return true
    }
    return false
}

function unlink(node: Consumer): void {
    for (const s of node.sources) s.observers.delete(node)
    node.sources.clear()
}

function flush(): void {
    if (batchDepth > 0) return
    // Watchers may write, queueing more watchers; drain until quiet.
    let guard = 0
    while (pending.size > 0) {
        if (++guard > 1000) throw new Error('weft: propagation did not settle')
        const round = [...pending]
        pending.clear()
        for (const w of round) w.stabilize()
    }
}

/** Group writes so watchers see one settled picture. */
export function batch<T>(fn: () => T): T {
    batchDepth++
    try {
        return fn()
    } finally {
        batchDepth--
        flush()
    }
}

/** Read without becoming dependent on it. */
export function untracked<T>(fn: () => T): T {
    const prev = active
    active = null
    try {
        return fn()
    } finally {
        active = prev
    }
}

export interface CellOptions<T> {
    equal?: Equal<T>
    name?: string
}

/** Stored cell: the only thing that can be written, by its single writer. */
export class Input<T> implements Source {
    readonly observers = new Set<Consumer>()
    readonly name: string
    private current: T
    private readonly equal: Equal<T>

    constructor(initial: T, options: CellOptions<T> = {}) {
        this.current = initial
        this.equal = options.equal ?? Object.is
        this.name = options.name ?? 'input'
    }

    stabilize(): void {}

    get(): T {
        track(this)
        return this.current
    }

    peek(): T {
        return this.current
    }

    set(next: T): void {
        if (this.equal(this.current, next)) return
        this.current = next
        for (const o of this.observers) markDirty(o)
        flush()
    }

    update(fn: (prev: T) => T): void {
        this.set(fn(this.current))
    }
}

/** Derived cell: a formula. Nobody writes it; it recomputes when its inputs move. */
export class Cell<T> implements Source, Consumer {
    state: State = DIRTY
    readonly sources = new Set<Source>()
    readonly observers = new Set<Consumer>()
    readonly name: string
    private value!: T
    private valued = false
    private computing = false
    private readonly formula: () => T
    private readonly equal: Equal<T>

    constructor(formula: () => T, options: CellOptions<T> = {}) {
        this.formula = formula
        this.equal = options.equal ?? Object.is
        this.name = options.name ?? 'cell'
    }

    get(): T {
        track(this)
        this.stabilize()
        return this.value
    }

    peek(): T {
        return untracked(() => this.get())
    }

    /** Somebody downstream is reading this cell right now. */
    get observed(): boolean {
        return this.observers.size > 0
    }

    /** Let go of the sources. Next read recomputes from scratch. */
    dispose(): void {
        if (this.computing) throw new Error(`weft: cannot dispose cell "${this.name}" while it computes`)
        unlink(this)
        this.state = DIRTY
        this.valued = false
    }

    stabilize(): void {
        if (this.state === CLEAN) return
        if (this.computing) throw new Error(`weft: cycle through cell "${this.name}"`)
        if (this.state === CHECK && !verify(this)) {
            this.state = CLEAN
            return
        }
        this.recompute()
    }

    private recompute(): void {
        unlink(this)
        const prevActive = active
        active = this
        this.computing = true
        let next: T
        try {
            next = this.formula()
        } finally {
            this.computing = false
            active = prevActive
        }
        const changed = !this.valued || !this.equal(this.value, next)
        this.value = next
        this.valued = true
        this.state = CLEAN
        // Equal result stops here: observers stay CHECK and settle without recomputing.
        if (changed) for (const o of this.observers) markDirty(o)
    }
}

/** Watcher: leaf of the graph. Runs its body, then reruns it when what it read moves. */
export class Watcher implements Consumer {
    state: State = DIRTY
    readonly sources = new Set<Source>()
    readonly observers = new Set<Consumer>()
    private disposed = false
    private readonly body: () => void

    constructor(body: () => void) {
        this.body = body
        this.run()
    }

    stabilize(): void {
        if (this.disposed || this.state === CLEAN) return
        if (this.state === CHECK && !verify(this)) {
            this.state = CLEAN
            return
        }
        this.run()
    }

    private run(): void {
        unlink(this)
        const prevActive = active
        active = this
        try {
            this.body()
        } finally {
            active = prevActive
            this.state = CLEAN
        }
    }

    dispose(): void {
        if (this.disposed) return
        this.disposed = true
        unlink(this)
        pending.delete(this)
    }
}

export function input<T>(initial: T, options?: CellOptions<T>): Input<T> {
    return new Input(initial, options)
}

export function cell<T>(formula: () => T, options?: CellOptions<T>): Cell<T> {
    return new Cell(formula, options)
}

export function watch(body: () => void): () => void {
    const w = new Watcher(body)
    return () => w.dispose()
}

export type Readable<T> = Input<T> | Cell<T>

/** Watch one cell; the listener sees only actual changes. */
export function subscribe<T>(source: Readable<T>, listener: (value: T) => void): () => void {
    let first = true
    return watch(() => {
        const value = source.get()
        if (first) {
            first = false
            return
        }
        untracked(() => listener(value))
    })
}