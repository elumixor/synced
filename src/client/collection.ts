import type { Envelope, Identified, Intent } from "../protocol";
import type { Signals } from "./signals";

/**
 * A write whose meaning belongs to the server: answering an invitation, archiving a Gmail thread,
 * moving a Notion page. The client says only what the screen should show while the server decides,
 * and how to take it back if the user undoes it.
 */
export interface ActionSpec<T extends Identified, P> {
  /** The record as it should look the instant the button is pressed. */
  optimistic?(record: T, payload: P): Partial<T>;
  /** What undoing this means. Omitted, the action simply isn't undoable. */
  invert?(record: T, payload: P): Intent<T> | null;
}

export type ActionMap<T extends Identified> = Readonly<Record<string, ActionSpec<T, never>>>;

/** The payload one action takes, read back off the spec the screens were typed against. */
export type PayloadOf<S> = S extends { optimistic: (record: never, payload: infer P) => unknown }
  ? P
  : S extends { invert: (record: never, payload: infer P) => unknown }
    ? P
    : unknown;

/** How a model's records are ordered on screen, and what can be done to one. */
export interface ModelSpec<T extends Identified, A = ActionMap<T>> {
  /** Server order — the order the pull returned — by default. */
  compare?(a: T, b: T): number;
  readonly actions?: A;
  /** Never assigned: it's how the client reads a model's record type back out of its spec. */
  readonly record?: T;
}

/**
 * Any model's spec, for the code that holds every model at once and cares about none of them.
 * Written structurally rather than as `ModelSpec<Identified>`: a spec for a real record type is
 * not assignable to a spec for the bare identity, and this only ever needs to be a constraint.
 */
export interface AnyModelSpec {
  compare?: (a: never, b: never) => number;
  readonly actions?: Readonly<
    Record<string, { optimistic?: (...args: never[]) => object; invert?: (...args: never[]) => Intent | null }>
  >;
  readonly record?: Identified;
}

export type RecordOf<S> = S extends { readonly record?: infer T } ? (T extends Identified ? T : never) : never;

export type ActionsOf<S> = S extends { readonly actions?: infer A } ? A : never;

/**
 * Names a model's record type, and infers its actions' payload types from the same object the
 * screens call. Curried because TypeScript won't infer one type parameter while another is given.
 */
export function model<T extends Identified>() {
  return <A extends ActionMap<T>>(spec: ModelSpec<T, A> = {}): ModelSpec<T, A> => spec;
}

/** What a collection needs from the client that owns the queue every model writes into. */
export interface CollectionHost {
  apply(intent: Intent): void;
  pending(model: string): readonly Intent[];
  newId(): string;
}

/** Asking to change a record nothing knows about is a bug in the caller, not a sync failure. */
export class UnknownRecordError extends Error {
  constructor(
    readonly model: string,
    readonly id: string,
  ) {
    super(`No ${model} record with id ${id}`);
    this.name = "UnknownRecordError";
  }
}

/** A model can only be asked to do what it was defined as able to do. */
export class UnknownActionError extends Error {
  constructor(
    readonly model: string,
    readonly action: string,
  ) {
    super(`${model} has no action "${action}"`);
    this.name = "UnknownActionError";
  }
}

/** A model's records as the server last described them, and how fresh that description is. */
export interface CollectionSnapshot<T extends Identified> {
  readonly since: number;
  readonly records: readonly Envelope<T>[];
}

/**
 * One model's records, as the screen sees them.
 *
 * The screen sees the server's records with the writes it hasn't acknowledged yet replayed over
 * the top — every time either half changes. That's the whole reconciliation story: a response can
 * never overwrite an edit, because the edit is re-applied after the response lands, and a write
 * the server refuses simply stops being replayed, so the row snaps back to the truth on its own.
 */
export class SyncedCollection<T extends Identified, A = ActionMap<T>> {
  readonly #confirmed = new Map<string, Envelope<T>>();
  readonly #view;
  readonly #ready;
  #since = 0;

  constructor(
    readonly name: string,
    private readonly spec: ModelSpec<T, A>,
    private readonly host: CollectionHost,
    signals: Signals,
  ) {
    this.#view = signals.state<readonly T[]>([]);
    this.#ready = signals.state(false);
  }

  /**
   * Whether these records have been heard about at all — from the server or from the device.
   * False is what a skeleton is for; an empty list that is `ready` means the user has none.
   */
  get ready() {
    return this.#ready.value;
  }

  /** Every live record, in the server's order unless the model asked for another. */
  get all(): readonly T[] {
    return this.#view.value;
  }

  get since() {
    return this.#since;
  }

  /**
   * A live handle on one record: reads always see the current value, and assigning to a field
   * writes an update for that field alone. `undefined` when nothing by that id is on screen.
   */
  get(id: string): T | undefined {
    if (!this.#find(id)) return undefined;
    return new Proxy({} as T, {
      get: (_, key) => this.require(id)[key as keyof T],
      set: (_, key, value) => {
        this.update(id, { [key as keyof T]: value } as Partial<T>);
        return true;
      },
      has: (_, key) => key in this.require(id),
      ownKeys: () => Reflect.ownKeys(this.require(id)),
      getOwnPropertyDescriptor: (_, key) => ({
        ...Object.getOwnPropertyDescriptor(this.require(id), key),
        configurable: true,
      }),
    });
  }

  /** On screen before the request that carries it is even built. Its id is final from here on. */
  create(data: Omit<T, "id"> & Partial<Identified>): T {
    const record = { ...data, id: data.id ?? this.host.newId() } as T;
    this.host.apply({ kind: "create", model: this.name, id: record.id, data: record });
    return record;
  }

  /** The fields named here, and no others — an untouched field is never part of the write. */
  update(id: string, patch: Partial<T>) {
    this.require(id);
    this.host.apply({ kind: "update", model: this.name, id, patch });
  }

  delete(id: string) {
    this.require(id);
    this.host.apply({ kind: "delete", model: this.name, id });
  }

  /** Runs one of the model's server-owned writes, drawn immediately as the spec says to. */
  act<K extends keyof A & string>(name: K, id: string, payload: PayloadOf<A[K]>) {
    this.require(id);
    if (!this.#actions[name]) throw new UnknownActionError(this.name, name);
    this.host.apply({ kind: "action", model: this.name, id, name, payload });
  }

  /** The write that takes `intent` back, worked out against the records as they are right now. */
  invert(intent: Intent): Intent | null {
    const current = this.#find(intent.id);
    switch (intent.kind) {
      case "create":
        return { kind: "delete", model: this.name, id: intent.id };
      case "delete":
        return current ? { kind: "create", model: this.name, id: intent.id, data: current } : null;
      case "update": {
        if (!current) return null;
        const patch = Object.fromEntries(
          Object.keys(intent.patch).map((key) => [key, current[key as keyof T]]),
        ) as Partial<T>;
        return { kind: "update", model: this.name, id: intent.id, patch };
      }
      case "action": {
        const spec = this.#actions[intent.name];
        if (!current || !spec?.invert) return null;
        return spec.invert(current, intent.payload as never);
      }
    }
  }

  /** Takes in what a pull returned. Tombstones are kept: they're what makes a delete travel. */
  absorb(changes: readonly Envelope<T>[], since: number) {
    for (const envelope of changes) {
      // A server reading from a replica can answer with a row it wrote before the one already
      // held. Taking it would undo a change this client has already been told about — including
      // a delete, which would put the record back on screen.
      const held = this.#confirmed.get(envelope.id);
      if (held && held.updatedAt > envelope.updatedAt) continue;
      this.#confirmed.set(envelope.id, envelope);
    }
    this.#since = Math.max(this.#since, since);
    this.#ready.value = true;
  }

  /** Recomputed by the client whenever the confirmed records or the pending queue move. */
  refresh() {
    this.#view.value = this.#project();
  }

  snapshot(): CollectionSnapshot<T> {
    return { since: this.#since, records: [...this.#confirmed.values()] };
  }

  restore(snapshot: CollectionSnapshot<T>) {
    this.#confirmed.clear();
    for (const envelope of snapshot.records) this.#confirmed.set(envelope.id, envelope);
    this.#since = snapshot.since;
    this.#ready.value = true;
  }

  clear() {
    this.#confirmed.clear();
    this.#since = 0;
    this.#view.value = [];
    this.#ready.value = false;
  }

  require(id: string) {
    const record = this.#find(id);
    if (!record) throw new UnknownRecordError(this.name, id);
    return record;
  }

  #project(): readonly T[] {
    const records = new Map<string, T>();
    for (const envelope of this.#confirmed.values()) {
      if (!envelope.deleted && envelope.data) records.set(envelope.id, envelope.data);
    }
    for (const intent of this.host.pending(this.name)) {
      const current = records.get(intent.id);
      if (intent.kind === "create") records.set(intent.id, intent.data as T);
      else if (intent.kind === "delete") records.delete(intent.id);
      else if (!current) continue;
      else if (intent.kind === "update") records.set(intent.id, { ...current, ...(intent.patch as Partial<T>) });
      else {
        const optimistic = this.#actions[intent.name]?.optimistic;
        if (optimistic) records.set(intent.id, { ...current, ...optimistic(current, intent.payload as never) });
      }
    }
    const list = [...records.values()];
    return this.spec.compare ? list.sort(this.spec.compare) : list;
  }

  #find(id: string) {
    return this.#view.value.find((record) => record.id === id);
  }

  get #actions(): ActionMap<T> {
    return (this.spec.actions ?? {}) as ActionMap<T>;
  }
}
