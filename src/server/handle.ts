import { z } from "zod";
import type { Envelope, Mutation, RejectedMutation, SyncRequest, SyncResponse } from "../protocol";
import { type AnySyncedModel, RejectedError } from "./model";

/**
 * Which writes this server has already carried out.
 *
 * A client that never heard the answer sends the same write again, and for a mailbox or a
 * calendar "again" is a second email, a second event. Remembering the ids is what makes a retry
 * free — and it's the only durable state the sync layer itself owns.
 */
export interface MutationLog {
  seen(userId: string, mutationIds: readonly string[]): Promise<ReadonlySet<string>>;
  remember(userId: string, mutationIds: readonly string[]): Promise<void>;
}

/** One write on the wire, checked at the edge so a malformed body is a 400, not a half-batch. */
export const mutationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create"),
    mutationId: z.string(),
    model: z.string(),
    id: z.string(),
    data: z.looseObject({ id: z.string() }),
  }),
  z.object({
    kind: z.literal("update"),
    mutationId: z.string(),
    model: z.string(),
    id: z.string(),
    patch: z.looseObject({ id: z.string().optional() }),
  }),
  z.object({ kind: z.literal("delete"), mutationId: z.string(), model: z.string(), id: z.string() }),
  z.object({
    kind: z.literal("action"),
    mutationId: z.string(),
    model: z.string(),
    id: z.string(),
    name: z.string(),
    payload: z.unknown(),
  }),
]);

/** How fresh each model's copy is, by model name. */
export const sinceSchema = z.record(z.string(), z.number());

/**
 * The server half of one round trip: apply what the client did, then say what changed.
 *
 * Writes are applied in the order they were made — a record created and then renamed can't arrive
 * the other way round — and one bad write doesn't take the batch with it: it comes back named, so
 * the client can drop it and show why. A write that fails for a reason a retry could fix (the
 * database is down, the calendar API timed out) is not rejected; it's thrown, the whole request
 * fails, and the client tries again with the queue intact.
 */
export class SyncServer {
  readonly #models: ReadonlyMap<string, AnySyncedModel>;

  constructor(
    models: readonly AnySyncedModel[],
    private readonly log: MutationLog,
  ) {
    this.#models = new Map(models.map((model) => [model.name, model]));
  }

  async handle(userId: string, request: SyncRequest): Promise<SyncResponse> {
    const applied: string[] = [];
    const rejected: RejectedMutation[] = [];
    const seen = await this.log.seen(
      userId,
      request.mutations.map((mutation) => mutation.mutationId),
    );
    const fresh: string[] = [];

    for (const mutation of request.mutations) {
      if (seen.has(mutation.mutationId)) {
        applied.push(mutation.mutationId);
        continue;
      }
      try {
        await this.#apply(userId, mutation);
        applied.push(mutation.mutationId);
        fresh.push(mutation.mutationId);
      } catch (e) {
        if (!(e instanceof RejectedError) && !(e instanceof z.ZodError)) throw e;
        rejected.push({ mutationId: mutation.mutationId, reason: reasonOf(e) });
      }
    }
    if (fresh.length > 0) await this.log.remember(userId, fresh);

    const changes: Record<string, readonly Envelope[]> = {};
    const since: Record<string, number> = {};
    for (const [name, model] of this.#models) {
      const from = request.since[name] ?? 0;
      const pulled = await model.pull(userId, from);
      changes[name] = pulled;
      since[name] = pulled.reduce((newest, envelope) => Math.max(newest, envelope.updatedAt), from);
    }
    return { changes, since, applied, rejected };
  }

  #apply(userId: string, mutation: Mutation) {
    const model = this.#models.get(mutation.model);
    if (!model) throw new RejectedError(`Unknown model "${mutation.model}".`);
    return model.apply(userId, mutation);
  }
}

function reasonOf(error: RejectedError | z.ZodError) {
  if (error instanceof RejectedError) return error.message;
  const [first] = error.issues;
  return first ? `${first.path.join(".") || "record"}: ${first.message}` : "Invalid record.";
}
