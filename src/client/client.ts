import type { Identified, Intent, Mutation, RejectedMutation, SyncRequest, SyncResponse } from "../protocol";
import {
  type ActionMap,
  type ActionsOf,
  type AnyModelSpec,
  type CollectionHost,
  type CollectionSnapshot,
  type ModelSpec,
  type RecordOf,
  SyncedCollection,
} from "./collection";
import { History } from "./history";
import { plainSignals, type Signals } from "./signals";
import { memoryStorage, type SyncedStorage } from "./storage";

export type SyncTransport = (request: SyncRequest) => Promise<SyncResponse>;

/** Every model this client syncs, named the way the screens and the server both name it. */
export type ModelSpecs = Readonly<Record<string, AnyModelSpec>>;

export type Collections<S extends ModelSpecs> = {
  readonly [K in keyof S]: SyncedCollection<RecordOf<S[K]>, ActionsOf<S[K]>>;
};

/** The collections seen from inside, where one model is much like another. */
type AnyCollection = SyncedCollection<Identified, ActionMap<Identified>>;

/** The record types are erased here and put back by `Collections<S>` on the way out. */
type ErasedSpec = ModelSpec<Identified, ActionMap<Identified>>;

export interface RetryOptions {
  /** How long to wait after the first failed round trip; doubles from there. */
  readonly baseMs?: number;
  readonly maxMs?: number;
}

export interface SyncedClientOptions<S extends ModelSpecs> {
  readonly models: S;
  readonly transport: SyncTransport;
  readonly storage?: SyncedStorage;
  readonly signals?: Signals;
  /** Namespaces the stored keys, so two clients on one device can't read each other's records. */
  readonly prefix?: string;
  readonly newId?: () => string;
  readonly schedule?: (run: () => void, ms: number) => void;
  readonly random?: () => number;
  readonly retry?: RetryOptions;
  /** A write the server will never accept — the caller decides what the user is told. */
  readonly onRejected?: (rejected: RejectedMutation, mutation: Mutation | undefined) => void;
  readonly onError?: (error: unknown) => void;
}

const DEFAULT_RETRY: Required<RetryOptions> = { baseMs: 1_000, maxMs: 30_000 };

/**
 * The queue of writes that haven't been acknowledged, and the one loop that drains it.
 *
 * Every model rides the same request: a burst of edits across three screens is one round trip,
 * and the reads that come back can't disagree with the writes that went up, because they were
 * decided together. Only one request is ever in flight — anything the user does while it's out
 * goes in the next one — which is what keeps two retries of the same write from racing.
 *
 * Nothing is dropped on failure. The queue is on disk, so a write typed on a train survives the
 * tunnel, the app being killed, and the phone being restarted, and every write carries an id the
 * server recognises, so arriving twice costs nothing.
 */
export class SyncedClient<S extends ModelSpecs> {
  readonly models: Collections<S>;
  readonly history: History;

  readonly #collections: Readonly<Record<string, AnyCollection>>;

  #queue: Mutation[] = [];
  readonly #syncing;
  readonly #error;
  readonly #pending;

  readonly #storage: SyncedStorage;
  readonly #prefix: string;
  readonly #newId: () => string;
  readonly #schedule: (run: () => void, ms: number) => void;
  readonly #random: () => number;
  readonly #retry: Required<RetryOptions>;

  #inflight: Promise<void> | null = null;
  #dirtyAgain = false;
  #failures = 0;
  #retryScheduled = false;
  #hydrated = false;
  #firstSync: Promise<void> | null = null;
  /** The mutations the round in flight is carrying, which must not be rewritten under it. */
  #sending: ReadonlySet<string> = new Set();
  /** How many `beginStep` calls are open; the outermost one decides what an undo step is. */
  #stepDepth = 0;
  /** Set while a group of writes is being collected into a single undo step. */
  #step: { forward: Intent[]; inverse: (Intent | null)[] } | null = null;
  /** Set while undo or redo is replaying, so its own writes don't become new steps. */
  #replaying = false;

  constructor(private readonly options: SyncedClientOptions<S>) {
    const signals = options.signals ?? plainSignals;
    this.#storage = options.storage ?? memoryStorage();
    this.#prefix = options.prefix ?? "synced:v1";
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    this.#schedule = options.schedule ?? ((run, ms) => void setTimeout(run, ms));
    this.#random = options.random ?? Math.random;
    this.#retry = { ...DEFAULT_RETRY, ...options.retry };
    this.#syncing = signals.state(false);
    this.#error = signals.state<string | null>(null);
    this.#pending = signals.state(0);
    this.history = new History(signals);

    const host: CollectionHost = {
      apply: (intent) => this.#apply(intent),
      pending: (model) => this.#queue.filter((mutation) => mutation.model === model),
      newId: this.#newId,
    };
    const collections: Record<string, AnyCollection> = {};
    for (const name of this.#names) {
      collections[name] = new SyncedCollection(name, options.models[name] as ErasedSpec, host, signals);
    }
    this.#collections = collections;
    this.models = collections as unknown as Collections<S>;
  }

  /** A request is out behind records that are already on screen. Never true on a first load. */
  get syncing() {
    return this.#syncing.value;
  }

  /** The last round trip's failure, still unresolved. Cleared by the next one that lands. */
  get error() {
    return this.#error.value;
  }

  /** How many writes the server hasn't acknowledged — what "saving…" and "offline" read. */
  get pendingCount() {
    return this.#pending.value;
  }

  /**
   * Puts last session's records and unsent writes back, before the first frame where storage can
   * answer that fast. Safe to call twice; only the first call reads.
   */
  hydrate() {
    if (this.#hydrated) return Promise.resolve();
    this.#hydrated = true;
    const readSync = this.#storage.readSync?.bind(this.#storage);
    if (!readSync) return this.#hydrateAsync();
    for (const name of this.#names) this.#restoreModel(name, readSync(this.#modelKey(name)));
    this.#restoreQueue(readSync(this.#queueKey));
    this.#refresh();
    return Promise.resolve();
  }

  /** One round trip, the first time anything asks. What a screen calls on mount. */
  ensure() {
    this.#firstSync ??= this.sync();
    return this.#firstSync;
  }

  /**
   * Opens an undo step that spans more than one turn of the event loop — a drag, a burst of
   * keystrokes. Everything written until `commitStep` is one press of undo. Nesting is flattened:
   * the outermost pair decides what a step is, so a helper that groups its own writes can't split
   * the burst it was called inside.
   */
  beginStep() {
    if (this.#replaying) return;
    this.#stepDepth += 1;
    this.#step ??= { forward: [], inverse: [] };
  }

  commitStep() {
    if (this.#replaying || this.#stepDepth === 0) return;
    this.#stepDepth -= 1;
    if (this.#stepDepth > 0) return;
    const step = this.#step;
    this.#step = null;
    if (step) this.history.push(step.forward, step.inverse);
  }

  /** The same thing for a burst that starts and ends in one go. */
  transaction<R>(edit: () => R): R {
    this.beginStep();
    try {
      return edit();
    } finally {
      this.commitStep();
    }
  }

  /** Sends the writes that take the last step back. Not a rollback — see `History`. */
  undo() {
    this.#replay(this.history.undo());
  }

  redo() {
    this.#replay(this.history.redo());
  }

  /**
   * One round trip: the queue goes up, everything that changed since last time comes back.
   *
   * Calling it while a request is out doesn't start a second one — it joins the one in flight and
   * marks that another is owed, which is what a screen calling `sync()` on every mount wants.
   */
  sync(): Promise<void> {
    if (this.#inflight) {
      this.#dirtyAgain = true;
      return this.#inflight;
    }
    this.#inflight = this.#round().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  /**
   * Rounds until the queue is empty or one makes no progress. For a screen closing on an unsent
   * edit, and for tests. A round already in flight is waited out first rather than joined: it was
   * built before this call, so it may not carry what the caller is waiting for.
   */
  async flush() {
    while (this.#queue.length > 0) {
      if (this.#inflight) await this.#inflight;
      const before = this.#queue.length;
      await this.sync();
      if (this.#queue.length >= before) return;
    }
  }

  /** Sign-out: the next account must not see these records, on screen or on the device. */
  async clear() {
    this.#queue = [];
    this.#pending.value = 0;
    this.#error.value = null;
    this.history.clear();
    for (const name of this.#names) this.#collections[name].clear();
    await Promise.all(this.#names.map((name) => this.#storage.remove(this.#modelKey(name))));
    await this.#storage.remove(this.#queueKey);
  }

  async #round() {
    this.#syncing.value = true;
    const sending = [...this.#queue];
    this.#sending = new Set(sending.map((mutation) => mutation.mutationId));
    const since = Object.fromEntries(this.#names.map((name) => [name, this.#collections[name].since]));
    try {
      const response = await this.options.transport({ since, mutations: sending });
      this.#accept(response, sending);
      this.#failures = 0;
      this.#error.value = null;
      await this.#persist();
      if (this.#dirtyAgain || this.#queue.length > 0) {
        this.#dirtyAgain = false;
        this.#schedule(() => void this.sync(), 0);
      }
    } catch (e) {
      this.#error.value = e instanceof Error ? e.message : "Couldn't reach the server.";
      this.options.onError?.(e);
      this.#scheduleRetry();
    } finally {
      this.#sending = new Set();
      this.#syncing.value = false;
    }
  }

  /**
   * The server's answer, taken in one piece: what it now holds, and which of our writes it has
   * durably applied or will never apply. Both are dropped from the queue — a rejected write that
   * stayed would be replayed over every future response, and the row would never come right.
   */
  #accept(response: SyncResponse, sent: readonly Mutation[]) {
    for (const name of this.#names) {
      const collection = this.#collections[name];
      collection.absorb(response.changes[name] ?? [], response.since[name] ?? collection.since);
    }
    const settled = new Set([...response.applied, ...response.rejected.map((r) => r.mutationId)]);
    this.#queue = this.#queue.filter((mutation) => !settled.has(mutation.mutationId));
    this.#pending.value = this.#queue.length;
    this.#refresh();
    if (!this.options.onRejected) return;
    const bySentId = new Map(sent.map((mutation) => [mutation.mutationId, mutation]));
    for (const rejected of response.rejected) this.options.onRejected(rejected, bySentId.get(rejected.mutationId));
  }

  /** The one path every write takes: undo step first, then queue, then screen, then server. */
  #apply(intent: Intent) {
    if (!this.#replaying) {
      const inverse = this.#collections[intent.model].invert(intent);
      if (this.#step) {
        this.#step.forward.push(intent);
        this.#step.inverse.push(inverse);
      } else {
        this.history.push([intent], [inverse]);
      }
    }
    this.#queue = this.#queued(intent);
    this.#pending.value = this.#queue.length;
    this.#collections[intent.model].refresh();
    void this.#persistQueue();
    void this.sync();
  }

  /**
   * The queue with `intent` in it, folded into the write already waiting where that says the same
   * thing. A slider dragged across a screen is one write to send, not two hundred — but only
   * while nothing has gone up: a mutation the server may already have seen keeps its own identity.
   */
  #queued(intent: Intent): Mutation[] {
    const last = this.#queue.at(-1);
    const mergeable =
      intent.kind === "update" &&
      last?.kind === "update" &&
      last.model === intent.model &&
      last.id === intent.id &&
      !this.#sending.has(last.mutationId);
    if (!mergeable) return [...this.#queue, { ...intent, mutationId: this.#newId() }];
    const merged: Mutation = { ...last, patch: { ...last.patch, ...intent.patch } };
    return [...this.#queue.slice(0, -1), merged];
  }

  #replay(intents: readonly Intent[]) {
    if (intents.length === 0) return;
    this.#replaying = true;
    try {
      for (const intent of intents) this.#apply(intent);
    } finally {
      this.#replaying = false;
    }
  }

  #scheduleRetry() {
    if (this.#retryScheduled) return;
    this.#retryScheduled = true;
    this.#failures += 1;
    const window = Math.min(this.#retry.baseMs * 2 ** (this.#failures - 1), this.#retry.maxMs);
    // Jittered, so a server coming back up doesn't meet every client that was waiting at once.
    const delay = window / 2 + this.#random() * (window / 2);
    this.#schedule(() => {
      this.#retryScheduled = false;
      void this.sync();
    }, delay);
  }

  #refresh() {
    for (const name of this.#names) this.#collections[name].refresh();
  }

  get #names() {
    return Object.keys(this.options.models);
  }

  get #queueKey() {
    return `${this.#prefix}:queue`;
  }

  #modelKey(name: string) {
    return `${this.#prefix}:model:${name}`;
  }

  async #hydrateAsync() {
    const stored = await Promise.all(this.#names.map((name) => this.#storage.read(this.#modelKey(name))));
    this.#names.forEach((name, i) => {
      this.#restoreModel(name, stored[i] ?? null);
    });
    this.#restoreQueue(await this.#storage.read(this.#queueKey));
    this.#refresh();
  }

  #restoreModel(name: string, raw: string | null) {
    const snapshot = parse<CollectionSnapshot<Identified>>(raw);
    if (snapshot?.records) this.#collections[name].restore(snapshot);
  }

  #restoreQueue(raw: string | null) {
    this.#queue = parse<Mutation[]>(raw) ?? [];
    this.#pending.value = this.#queue.length;
  }

  async #persist() {
    await Promise.all([
      ...this.#names.map((name) =>
        this.#storage.write(this.#modelKey(name), JSON.stringify(this.#collections[name].snapshot())),
      ),
      this.#persistQueue(),
    ]);
  }

  #persistQueue() {
    return this.#storage.write(this.#queueKey, JSON.stringify(this.#queue));
  }
}

export function syncedClient<S extends ModelSpecs>(options: SyncedClientOptions<S>) {
  return new SyncedClient(options);
}

/** Storage holds whatever an older build wrote; a shape that no longer parses is just a miss. */
function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
