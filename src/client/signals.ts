/**
 * The one thing this library needs from a UI framework: a box whose reads are tracked.
 *
 * The core is plain TypeScript so it can be tested without a compiler step, and the app hands it
 * a box made of `$state`. Nothing else about Svelte leaks in here.
 */
export interface Signal<T> {
  value: T;
}

export interface Signals {
  state<T>(initial: T): Signal<T>;
}

/** For tests and for anything reading the collections outside a component. */
export const plainSignals: Signals = {
  state<T>(initial: T): Signal<T> {
    return { value: initial };
  },
};
