// Persistence. Only stored cells are kept — a formula is recomputed, never
// restored. What is kept carries the moment it arrived, so an answer that
// survives a reload is honest about its age instead of pretending to be new.

import { subscribe } from "./graph.ts";
import type { Input } from "./graph.ts";
import { heldOf } from "./remote.ts";
import type { Source } from "./source.ts";

export interface Store {
  read(key: string): string | null;
  write(key: string, text: string): void;
  remove(key: string): void;
}

/** Whatever was written last, in memory. For tests and for a fallback. */
export function memoryStore(seed: Record<string, string> = {}): Store {
  const cells = new Map<string, string>(Object.entries(seed));
  return {
    read: (key) => cells.get(key) ?? null,
    write: (key, text) => {
      cells.set(key, text);
    },
    remove: (key) => {
      cells.delete(key);
    },
  };
}

/** Browser storage, if there is any; otherwise an in-memory stand-in. */
export function webStore(area: "local" | "session" = "local"): Store {
  const backing =
    typeof globalThis === "object" && "localStorage" in globalThis
      ? ((area === "local" ? globalThis.localStorage : globalThis.sessionStorage) as Storage)
      : undefined;
  if (backing === undefined) return memoryStore();
  return {
    read: (key) => backing.getItem(key),
    write: (key, text) => {
      // A full or blocked store must not take the application down with it.
      try {
        backing.setItem(key, text);
      } catch {
        /* ignore */
      }
    },
    remove: (key) => {
      backing.removeItem(key);
    },
  };
}

/** Why something on disk was not put back. */
export type Dropped = "version" | "age" | "unreadable";

interface Envelope {
  v: number;
  at: number;
  value: unknown;
}

export interface KeepOptions<T> {
  key: string;
  store: Store;
  /** Bump it when the shape changes; anything written under another version is dropped or migrated. */
  version?: number;
  /** Anything older than this is not put back. */
  maxAge?: number;
  now?: () => number;
  /** Rescue what an older version wrote. Return undefined to drop it. */
  migrate?: (stored: unknown, from: number) => T | undefined;
  onDropped?: (why: Dropped, key: string) => void;
}

export interface Kept {
  /** Was something put back at startup. */
  readonly restored: boolean;
  /** Stop keeping it; what is on disk stays. */
  stop(): void;
  /** Stop keeping it and wipe what is on disk. */
  forget(): void;
}

function readEnvelope<T>(options: KeepOptions<T>): { value: unknown; at: number } | undefined {
  const { key, store, version = 1, maxAge, migrate, onDropped } = options;
  const now = options.now ?? Date.now;
  const text = store.read(key);
  if (text === null) return undefined;

  let envelope: Envelope;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    envelope = parsed as Envelope;
    if (typeof envelope.v !== "number" || typeof envelope.at !== "number") {
      throw new Error("no envelope");
    }
  } catch {
    onDropped?.("unreadable", key);
    store.remove(key);
    return undefined;
  }

  let value = envelope.value;
  if (envelope.v !== version) {
    const rescued = migrate?.(envelope.value, envelope.v);
    if (rescued === undefined) {
      onDropped?.("version", key);
      store.remove(key);
      return undefined;
    }
    value = rescued;
  }

  if (maxAge !== undefined && now() - envelope.at >= maxAge) {
    onDropped?.("age", key);
    store.remove(key);
    return undefined;
  }

  return { value, at: envelope.at };
}

function writeEnvelope<T>(options: KeepOptions<T>, value: unknown, at: number): void {
  const { key, store, version = 1 } = options;
  store.write(key, JSON.stringify({ v: version, at, value } satisfies Envelope));
}

/**
 * Keep a stored cell. Watching is cold: persistence records what happens
 * anyway and never asks for work of its own.
 */
export function keepInput<T>(target: Input<T>, options: KeepOptions<T>): Kept {
  const now = options.now ?? Date.now;
  const found = readEnvelope(options);
  if (found !== undefined) target.set(found.value as T);

  const stop = subscribe(
    target,
    (value) => {
      writeEnvelope(options, value, now());
    },
    { demand: false },
  );

  return {
    restored: found !== undefined,
    stop,
    forget: () => {
      stop();
      options.store.remove(options.key);
    },
  };
}

/**
 * Keep what a source last held. The moment of arrival is kept with it, so after
 * a reload the value is as old as it really is: within shelf life it is served
 * as it stands, past it the first demand asks again.
 */
export function keepSource<T>(feed: Source<T>, options: KeepOptions<T>): Kept {
  const found = readEnvelope(options);
  if (found !== undefined) feed.restore(found.value as T, found.at);

  const stop = subscribe(
    feed.state,
    (state) => {
      const held = heldOf(state);
      // Nothing held yet, and a refusal never overwrites a good answer.
      if (held === undefined) return;
      writeEnvelope(options, held.value, held.at);
    },
    { demand: false },
  );

  return {
    restored: found !== undefined,
    stop,
    forget: () => {
      stop();
      options.store.remove(options.key);
    },
  };
}
