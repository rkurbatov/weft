// The wire between a graph and whoever is watching it. Two functions — send and
// listen — and a handful of messages. In one process the two ends are a pair of
// functions; in a browser they are a worker; nothing above this layer can tell.

export interface Channel {
  send(message: unknown): void;
  /** Returns the way to stop listening. */
  listen(handler: (message: unknown) => void): () => void;
}

export type ToGraph =
  | { readonly kind: "watch"; readonly id: number; readonly cell: string; readonly key?: unknown }
  | { readonly kind: "unwatch"; readonly id: number }
  | {
      readonly kind: "call";
      readonly id: number;
      readonly command: string;
      readonly args: readonly unknown[];
    };

export type ToWatcher =
  | { readonly kind: "values"; readonly changed: ReadonlyArray<{ id: number; value: unknown }> }
  | { readonly kind: "done"; readonly id: number; readonly value: unknown }
  | { readonly kind: "failed"; readonly id: number; readonly error: string };

/** What a mirrored cell holds: nothing yet, or the last value that arrived. */
export type Mirrored<T> = { readonly known: false } | { readonly known: true; readonly value: T };

export const NOT_YET: Mirrored<never> = { known: false };

export function valueOf<T>(seen: Mirrored<T>): T | undefined {
  return seen.known ? seen.value : undefined;
}

export function valueOr<T>(seen: Mirrored<T>, fallback: T): T {
  return seen.known ? seen.value : fallback;
}

/** What to do with work that must not happen more than once a frame. */
export type Schedule = (work: () => void) => void;

export const perFrame: Schedule =
  typeof requestAnimationFrame === "function"
    ? (work) => {
        requestAnimationFrame(() => work());
      }
    : (work) => {
        setTimeout(work, 0);
      };

/** Everything at once, for tests that want no waiting. */
export const atOnce: Schedule = (work) => work();
