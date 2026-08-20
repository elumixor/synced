import type { z } from "zod";
import type { Envelope, Identified, Mutation } from "../protocol";

/**
 * Where a model's records actually live.
 *
 * For most models that's a table, and these four methods are four queries. For some it isn't:
 * a model can be backed by Google Calendar, a Gmail mailbox, a Notion database — anything that
 * can answer "what changed since" and take a write. The sync loop, the retries, the ordering and
 * the client's optimism are the same either way, which is the point of putting them here once.
 *
 * Every method returns the record as it stands afterwards, stamped with the server's clock. That
 * stamp is the only thing the client compares against, so it has to come from whatever wrote it.
 */
export interface SyncedStore<T extends Identified> {
  /** Everything written at or after `since`, tombstones included, oldest first. */
  pull(userId: string, since: number): Promise<readonly Envelope<T>[]>;
  /** One record as it stands, or null if this user has none by that id. */
  read(userId: string, id: string): Promise<T | null>;
  /**
   * Adds the record under the id the client chose. Called again with the same id when a step is
   * redone after being undone, so it has to bring a deleted record back rather than complain.
   */
  create(userId: string, record: T): Promise<Envelope<T>>;
  /** Writes only the fields in `patch`; anything absent is left exactly as it was. */
  update(userId: string, id: string, patch: Partial<T>): Promise<Envelope<T>>;
  remove(userId: string, id: string): Promise<Envelope<T>>;
}

/** A server-owned write the client can ask for by name — an RSVP, an archive, a share. */
export interface ActionHandler<T extends Identified, P> {
  readonly payload: z.ZodType<P>;
  run(userId: string, id: string, payload: P): Promise<Envelope<T>>;
}

/**
 * What a model's actions have to look like, with the payload types erased — a schema for one
 * payload type isn't assignable to a schema for another, so the constraint can only ask for the
 * shape. `action()` is what keeps a handler's payload and its schema honest with each other.
 */
export interface ErasedActionHandler<T extends Identified> {
  readonly payload: { parse(value: unknown): unknown };
  run(userId: string, id: string, payload: never): Promise<Envelope<T>>;
}

export type ActionHandlers<T extends Identified> = Readonly<Record<string, ErasedActionHandler<T>>>;

/** Ties an action's payload schema to the handler that reads it, so neither can drift. */
export function action<T extends Identified, P>(
  payload: z.ZodType<P>,
  run: (userId: string, id: string, payload: P) => Promise<Envelope<T>>,
): ActionHandler<T, P> {
  return { payload, run };
}

/** A write that will never succeed, however often it's retried. The client is told why. */
export class RejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RejectedError";
  }
}

/** A model as the sync loop sees it, once it has stopped caring what kind of record it holds. */
export interface AnySyncedModel {
  readonly name: string;
  pull(userId: string, since: number): Promise<readonly Envelope[]>;
  apply(userId: string, mutation: Mutation): Promise<Envelope>;
}

export interface SyncedModelOptions<Schema extends z.ZodObject, T extends Identified> {
  readonly name: string;
  /** The whole record, as both sides agree it looks. Patches are validated against its partial. */
  readonly schema: Schema;
  readonly store: SyncedStore<T>;
  readonly actions?: ActionHandlers<T>;
  /** Rejects writes to rows the server manages itself — the buffer category, say. */
  readonly writable?: (record: T) => boolean;
}

/**
 * One model, as the server defines it: what its records look like, where they live, and what can
 * be done to one. Validation happens here rather than in the route, so a bad write is rejected
 * by name and the rest of the batch still lands.
 */
export class SyncedModel<Schema extends z.ZodObject = z.ZodObject, T extends Identified = z.infer<Schema> & Identified>
  implements AnySyncedModel
{
  constructor(private readonly options: SyncedModelOptions<Schema, T>) {}

  get name() {
    return this.options.name;
  }

  pull(userId: string, since: number) {
    return this.options.store.pull(userId, since);
  }

  async apply(userId: string, mutation: Mutation): Promise<Envelope<T>> {
    const { store, schema, actions, writable } = this.options;
    if (mutation.kind === "create") {
      const record = schema.parse({ ...mutation.data, id: mutation.id }) as T;
      // Checked on the way in as well as on the way over: a client allowed to make a row the
      // server manages itself has made one nobody — including that client — can ever write to.
      if (writable && !writable(record)) throw new RejectedError(`This ${this.name} record is read-only.`);
      return store.create(userId, record);
    }

    if (writable) {
      const existing = await store.read(userId, mutation.id);
      if (existing && !writable(existing)) throw new RejectedError(`This ${this.name} record is read-only.`);
    }

    switch (mutation.kind) {
      case "update":
        return store.update(userId, mutation.id, schema.partial().parse(mutation.patch) as Partial<T>);
      case "delete":
        return store.remove(userId, mutation.id);
      case "action": {
        const handler = actions?.[mutation.name];
        if (!handler) throw new RejectedError(`${this.name} has no action "${mutation.name}".`);
        return handler.run(userId, mutation.id, handler.payload.parse(mutation.payload) as never);
      }
    }
  }
}

export function syncedModel<Schema extends z.ZodObject>(
  options: SyncedModelOptions<Schema, z.infer<Schema> & Identified>,
) {
  return new SyncedModel(options);
}
