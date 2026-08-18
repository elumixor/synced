import { z } from "zod";
import type { Envelope, Identified, SyncRequest, SyncResponse } from "../src/protocol";
import { action, type MutationLog, RejectedError, type SyncedStore, SyncServer, syncedModel } from "../src/server";

export const noteSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  body: z.string(),
  pinned: z.boolean(),
});

export type Note = z.infer<typeof noteSchema>;

/** A store that behaves like a table: one row per id, a server clock, tombstones on delete. */
export class MemoryStore<T extends Identified> implements SyncedStore<T> {
  readonly #rows = new Map<string, Map<string, Envelope<T>>>();
  #clock = 0;

  /** Writes made straight to the store, as another device or another user's session would. */
  put(userId: string, record: T) {
    return this.#write(userId, record.id, record, false);
  }

  async pull(userId: string, since: number) {
    return [...this.#of(userId).values()]
      .filter((envelope) => envelope.updatedAt >= since)
      .sort((a, b) => a.updatedAt - b.updatedAt);
  }

  async read(userId: string, id: string) {
    return this.#of(userId).get(id)?.data ?? null;
  }

  async create(userId: string, record: T) {
    return this.#write(userId, record.id, record, false);
  }

  async update(userId: string, id: string, patch: Partial<T>) {
    const existing = this.#of(userId).get(id);
    if (!existing?.data) throw new RejectedError(`No record ${id}`);
    return this.#write(userId, id, { ...existing.data, ...patch }, false);
  }

  async remove(userId: string, id: string) {
    return this.#write(userId, id, null, true);
  }

  #write(userId: string, id: string, data: T | null, deleted: boolean) {
    const envelope: Envelope<T> = { id, updatedAt: ++this.#clock, deleted, data };
    this.#of(userId).set(id, envelope);
    return envelope;
  }

  #of(userId: string) {
    const rows = this.#rows.get(userId) ?? new Map<string, Envelope<T>>();
    this.#rows.set(userId, rows);
    return rows;
  }
}

export class MemoryLog implements MutationLog {
  readonly #applied = new Map<string, Set<string>>();

  async seen(userId: string, mutationIds: readonly string[]) {
    const known = this.#of(userId);
    return new Set(mutationIds.filter((id) => known.has(id)));
  }

  async remember(userId: string, mutationIds: readonly string[]) {
    const known = this.#of(userId);
    for (const id of mutationIds) known.add(id);
  }

  #of(userId: string) {
    const known = this.#applied.get(userId) ?? new Set<string>();
    this.#applied.set(userId, known);
    return known;
  }
}

/** How many times a note has been pinned by the `pin` action — proves an action ran exactly once. */
export const pinCounts = new Map<string, number>();

export function makeServer() {
  const store = new MemoryStore<Note>();
  const log = new MemoryLog();
  const notes = syncedModel({
    name: "notes",
    schema: noteSchema,
    store,
    writable: (note) => note.title !== "system",
    actions: {
      pin: action(z.object({ pinned: z.boolean() }), async (userId, id, payload) => {
        pinCounts.set(id, (pinCounts.get(id) ?? 0) + 1);
        return store.update(userId, id, { pinned: payload.pinned });
      }),
    },
  });
  return { store, log, server: new SyncServer([notes], log) };
}

export class Network {
  offline = false;
  /** Applies the request but loses the reply, the way a dropped connection does. */
  loseNextReply = false;
  requests = 0;

  constructor(
    private readonly server: SyncServer,
    private readonly userId = "u1",
  ) {}

  readonly transport = async (request: SyncRequest): Promise<SyncResponse> => {
    this.requests += 1;
    if (this.offline) throw new Error("offline");
    const response = await this.server.handle(this.userId, request);
    if (this.loseNextReply) {
      this.loseNextReply = false;
      throw new Error("connection reset");
    }
    return response;
  };
}

/** Deterministic ids and timers, so a test can say exactly when a retry happens. */
export function makeRuntime() {
  let next = 0;
  const timers: { run: () => void; ms: number }[] = [];
  return {
    newId: () => `id-${++next}`,
    random: () => 0.5,
    schedule: (run: () => void, ms: number) => void timers.push({ run, ms }),
    /** Runs what is scheduled right now — one generation, so a retry loop can be watched step by step. */
    async settle() {
      const due = timers.splice(0, timers.length);
      for (const timer of due) timer.run();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    delays: () => timers.map((timer) => timer.ms),
  };
}
