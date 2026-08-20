import { beforeEach, describe, expect, test } from "bun:test";
import {
  memoryStorage,
  model,
  type SyncedStorage,
  syncedClient,
  UnknownActionError,
  UnknownRecordError,
} from "../src/client";
import type { Envelope, Mutation, SyncRequest, SyncResponse } from "../src/protocol";
import { RejectedError, type SyncedStore, SyncServer, syncedModel } from "../src/server";
import { draft, MemoryLog, makeServer, Network, type Note, noteSchema, pinCounts, setup } from "./harness";

beforeEach(() => pinCounts.clear());

/**
 * What the queue does when a round trip half-happens, a session ends under it, or a caller asks
 * for something that isn't there. Everything here is a case where being nearly right is worse
 * than failing outright: an edit quietly lost, one account's records shown to the next.
 */
describe("a write the server may already have applied", () => {
  test("isn't rewritten by the next edit while its answer is still owed", async () => {
    // The server applied the write and the reply was lost, so the mutation id is spent: it is in
    // the server's log, and a retry under it is answered "already applied" without being read.
    // Folding a later edit into it therefore loses that edit for good.
    const { notes, client, network, runtime, store } = setup();
    const note = notes.create(draft);
    await client.flush();

    network.loseNextReply = true;
    notes.update(note.id, { body: "milk, bread" });
    await client.sync();

    notes.update(note.id, { body: "milk, bread, jam" });
    await runtime.settle();
    await client.flush();

    expect((await store.read("u1", note.id))?.body).toBe("milk, bread, jam");
    expect(notes.all[0].body).toBe("milk, bread, jam");
  });

  test("is still merged with while it has never left the device", async () => {
    // The other half of the same rule: nothing was sent, so there is nothing to be honest about.
    const { notes, client, network } = setup();
    const note = notes.create(draft);
    await client.flush();

    network.offline = true;
    for (let i = 0; i < 20; i++) notes.update(note.id, { body: `draft ${i}` });
    const before = network.requests;
    network.offline = false;
    await client.flush();

    expect(network.requests - before).toBe(1);
    expect(notes.all[0].body).toBe("draft 19");
  });
});

describe("a session that ends under a request", () => {
  test("doesn't put the last account's records on the next one's screen", async () => {
    const { store, server } = makeServer();
    await store.put("u1", { id: "n1", title: "Payslip", body: "private", pinned: false });

    let release: ((response: SyncResponse) => void) | undefined;
    const client = syncedClient({
      models: { notes: model<Note>()({}) },
      transport: (request: SyncRequest) =>
        server.handle("u1", request).then(
          (response) =>
            new Promise<SyncResponse>((resolve) => {
              release = () => resolve(response);
            }),
        ),
      storage: memoryStorage(),
      prefix: "test",
      schedule: () => undefined,
    });

    const out = client.sync();
    await client.clear();
    release?.({ changes: { notes: [] }, since: {}, applied: [], rejected: [] });
    await out;

    expect(client.models.notes.all).toEqual([]);
    expect(client.models.notes.ready).toBe(false);
  });

  test("doesn't put the last account's queue back on the wire", async () => {
    const { notes, client, network, store } = setup();
    network.offline = true;
    const note = notes.create(draft);
    await client.sync();

    await client.clear();
    network.offline = false;
    await client.flush();

    expect(await store.read("u1", note.id)).toBeNull();
    expect(client.pendingCount).toBe(0);
  });
});

describe("what the screen may ask for", () => {
  test("says which record and which model when there isn't one", () => {
    const { notes } = setup();
    expect(() => notes.update("nope", { body: "x" })).toThrow(UnknownRecordError);
    expect(() => notes.delete("nope")).toThrow(UnknownRecordError);
    expect(() => notes.act("pin", "nope", { pinned: true })).toThrow(UnknownRecordError);
    expect(() => notes.require("nope")).toThrow("No notes record with id nope");
    expect(notes.get("nope")).toBeUndefined();
  });

  test("says so when a model has no such action", () => {
    const { notes } = setup();
    const note = notes.create(draft);
    // @ts-expect-error the point is the runtime check behind the type
    expect(() => notes.act("archive", note.id, {})).toThrow(UnknownActionError);
  });

  test("a handle on a record reads through to whatever it is now", async () => {
    const { notes, client } = setup();
    const note = notes.create(draft);
    const handle = notes.get(note.id);
    if (!handle) throw new Error("no handle");

    notes.update(note.id, { title: "Shopping" });
    expect(handle.title).toBe("Shopping");
    expect("body" in handle).toBe(true);
    expect(Object.keys(handle).sort()).toEqual(["body", "id", "pinned", "title"]);
    expect({ ...handle }).toEqual({ ...note, title: "Shopping" });

    handle.pinned = true;
    await client.flush();
    expect(notes.all[0].pinned).toBe(true);
  });

  test("an empty model is ready once the server has answered, not before", async () => {
    const { notes, client } = setup();
    expect(notes.ready).toBe(false);
    await client.ensure();
    expect(notes.ready).toBe(true);
    expect(notes.all).toEqual([]);
  });
});

describe("records the server describes twice", () => {
  test("an answer describing an older version doesn't undo a newer one", async () => {
    // Two rounds can't overlap, but a server that pulls from a replica can answer with a row it
    // wrote before the one this client already holds. The older row must not win.
    const responses: SyncResponse[] = [
      {
        changes: { notes: [envelope("n1", 5, { id: "n1", title: "Newer", body: "", pinned: false })] },
        since: { notes: 5 },
        applied: [],
        rejected: [],
      },
      {
        changes: { notes: [envelope("n1", 2, { id: "n1", title: "Older", body: "", pinned: false })] },
        since: { notes: 5 },
        applied: [],
        rejected: [],
      },
    ];
    const client = syncedClient({
      models: { notes: model<Note>()({}) },
      transport: async () => responses.shift() as SyncResponse,
      storage: memoryStorage(),
      prefix: "test",
      schedule: () => undefined,
    });

    await client.sync();
    expect(client.models.notes.all[0].title).toBe("Newer");
    await client.sync();
    expect(client.models.notes.all[0].title).toBe("Newer");
  });

  test("a tombstone that arrives late doesn't resurrect a record", async () => {
    const responses: SyncResponse[] = [
      {
        changes: { notes: [{ id: "n1", updatedAt: 9, deleted: true, data: null }] },
        since: { notes: 9 },
        applied: [],
        rejected: [],
      },
      {
        changes: { notes: [envelope("n1", 4, { id: "n1", title: "Back from the dead", body: "", pinned: false })] },
        since: { notes: 9 },
        applied: [],
        rejected: [],
      },
    ];
    const client = syncedClient({
      models: { notes: model<Note>()({}) },
      transport: async () => responses.shift() as SyncResponse,
      storage: memoryStorage(),
      prefix: "test",
      schedule: () => undefined,
    });

    await client.sync();
    await client.sync();
    expect(client.models.notes.all).toEqual([]);
  });
});

describe("the server's own rules", () => {
  test("a client can't create a record the server would refuse to let it write", async () => {
    // `writable` names the rows the server manages itself. A client that can make one has made a
    // row nobody can ever edit or delete, which is worse than not being allowed to make it.
    const { notes, client, rejections, store } = setup();
    const note = notes.create({ ...draft, title: "system" });
    await client.flush();

    expect(rejections).toEqual(["This notes record is read-only."]);
    expect(await store.read("u1", note.id)).toBeNull();
    expect(notes.all).toEqual([]);
  });

  test("a malformed write is named and the rest of the batch still lands", async () => {
    const { notes, client, rejections, store } = setup();
    const good = notes.create(draft);
    // The schema wants a non-empty title; the server is the only side that checks.
    const bad = notes.create({ ...draft, title: "" });
    await client.flush();

    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toContain("title");
    expect(await store.read("u1", good.id)).not.toBeNull();
    expect(await store.read("u1", bad.id)).toBeNull();
  });

  test("a write to a model the server doesn't have is rejected, not retried forever", async () => {
    const { server } = makeServer();
    const response = await server.handle("u1", {
      since: {},
      mutations: [{ kind: "delete", mutationId: "m1", model: "ghosts", id: "n1" }],
    });
    expect(response.rejected).toEqual([{ mutationId: "m1", reason: 'Unknown model "ghosts".' }]);
  });

  test("a failure a retry could fix takes the request down instead of being rejected", async () => {
    // A rejection is final — the client drops the write and tells the user. A database that is
    // down is not final, so it has to come back as a failed request with the queue intact.
    const store = brokenStore(new Error("connection refused"));
    const model = syncedModel({ name: "notes", schema: noteSchema, store });
    const server = new SyncServer([model], new MemoryLog());
    const mutations: Mutation[] = [{ kind: "update", mutationId: "m1", model: "notes", id: "n1", patch: {} }];

    await expect(server.handle("u1", { since: {}, mutations })).rejects.toThrow("connection refused");
  });

  test("a write the store refuses by name is rejected and the batch goes on", async () => {
    const store = brokenStore(new RejectedError("That note is gone."));
    const model = syncedModel({ name: "notes", schema: noteSchema, store });
    const server = new SyncServer([model], new MemoryLog());
    const response = await server.handle("u1", {
      since: {},
      mutations: [{ kind: "delete", mutationId: "m1", model: "notes", id: "n1" }],
    });

    expect(response.rejected).toEqual([{ mutationId: "m1", reason: "That note is gone." }]);
    expect(response.applied).toEqual([]);
  });
});

describe("undo of things that can't be undone", () => {
  test("an action with no inverse forgets the history rather than half-undoing it", async () => {
    const spec = model<Note>()({ actions: { pin: { optimistic: () => ({ pinned: true }) } } });
    const { server } = makeServer();
    const network = new Network(server);
    const client = syncedClient({
      models: { notes: spec },
      transport: network.transport,
      storage: memoryStorage(),
      prefix: "test",
      schedule: () => undefined,
    });
    const note = client.models.notes.create(draft);
    await client.flush();
    expect(client.history.canUndo).toBe(true);

    client.models.notes.act("pin", note.id, { pinned: true });
    expect(client.history.canUndo).toBe(false);
    client.undo();
    await client.flush();
    expect(client.models.notes.all[0].pinned).toBe(true);
  });

  test("undoing with nothing to undo does nothing at all", async () => {
    const { client, network } = setup();
    const before = network.requests;
    client.undo();
    client.redo();
    expect(network.requests).toBe(before);
    expect(client.history.canUndo).toBe(false);
  });

  test("a step opened and never written to leaves the stack alone", () => {
    const { client } = setup();
    client.beginStep();
    client.commitStep();
    // And a stray commit with no step open is not an error either.
    client.commitStep();
    expect(client.history.canUndo).toBe(false);
  });

  test("nested steps are one press of undo, decided by the outermost", async () => {
    const { notes, client } = setup();
    const note = notes.create(draft);
    await client.flush();

    client.beginStep();
    notes.update(note.id, { title: "One" });
    client.transaction(() => notes.update(note.id, { body: "two" }));
    notes.update(note.id, { pinned: true });
    client.commitStep();

    client.undo();
    await client.flush();
    expect(notes.all[0]).toMatchObject({ title: "Groceries", body: "milk", pinned: false });
  });

  test("only the last hundred steps can be taken back", async () => {
    const { notes, client } = setup();
    const note = notes.create(draft);
    await client.flush();
    for (let i = 0; i < 120; i++) {
      notes.update(note.id, { body: `edit ${i}` });
      await client.flush();
    }
    for (let i = 0; i < 200; i++) client.undo();
    await client.flush();
    // The create and the first twenty edits fell off the bottom, so the body goes back no further.
    expect(notes.all[0].body).toBe("edit 19");
    expect(client.history.canUndo).toBe(false);
  });

  test("redoing what was undone puts it back, and a new write cuts the branch", async () => {
    const { notes, client } = setup();
    const note = notes.create(draft);
    await client.flush();
    notes.update(note.id, { title: "One" });
    await client.flush();

    client.undo();
    await client.flush();
    expect(client.history.canRedo).toBe(true);
    client.redo();
    await client.flush();
    expect(notes.all[0].title).toBe("One");

    client.undo();
    await client.flush();
    notes.update(note.id, { body: "a new branch" });
    expect(client.history.canRedo).toBe(false);
  });
});

describe("what the screen watches while a write is out", () => {
  test("syncing is true only while a request is actually in flight", async () => {
    const { client, network, notes } = setup();
    expect(client.syncing).toBe(false);
    notes.create(draft);
    const out = client.sync();
    expect(client.syncing).toBe(true);
    await out;
    expect(client.syncing).toBe(false);
    expect(client.error).toBeNull();

    network.offline = true;
    notes.create(draft);
    await client.sync();
    expect(client.syncing).toBe(false);
    expect(client.error).toBe("offline");
    expect(client.pendingCount).toBe(1);
  });

  test("a transport that throws something that isn't an Error still says something", async () => {
    const client = syncedClient({
      models: { notes: model<Note>()({}) },
      transport: () => Promise.reject("a string"),
      storage: memoryStorage(),
      prefix: "test",
      schedule: () => undefined,
    });
    await client.sync();
    expect(client.error).toBe("Couldn't reach the server.");
  });
});

describe("a client given nothing but a transport", () => {
  test("makes its own ids, and retries on its own clock", async () => {
    // Everything else in this file injects ids, timers and randomness. The defaults are what an
    // app actually gets, and they have to be able to make a record and come back from a failure.
    const { server } = makeServer();
    const network = new Network(server);
    const client = syncedClient({
      models: { notes: model<Note>()({}) },
      transport: network.transport,
      retry: { baseMs: 1, maxMs: 1 },
    });

    network.offline = true;
    const note = client.models.notes.create(draft);
    expect(note.id).toMatch(/[0-9a-f-]{36}/);
    await client.sync();
    expect(client.pendingCount).toBe(1);

    network.offline = false;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.pendingCount).toBe(0);
    expect(client.models.notes.all.map((n) => n.id)).toEqual([note.id]);
  });
});

describe("the storage adapter the library ships", () => {
  test("holds what it was given, lists it, and forgets it", async () => {
    const storage = memoryStorage();
    expect(storage.readSync?.("nothing")).toBeNull();
    expect(await storage.read("nothing")).toBeNull();

    await storage.write("test:queue", "[]");
    expect(storage.readSync?.("test:queue")).toBe("[]");
    expect(await storage.read("test:queue")).toBe("[]");
    expect(await storage.keys()).toEqual(["test:queue"]);

    await storage.remove("test:queue");
    expect(await storage.keys()).toEqual([]);
  });

  test("signing out takes keys no configured model would name any more", async () => {
    const storage = memoryStorage();
    await storage.write("test:model:archived-model", '{"since":1,"records":[]}');
    const { client, notes } = setup({ storage });
    notes.create(draft);
    await client.flush();

    await client.clear();
    expect(await storage.keys()).toEqual([]);
  });
});

describe("storage that can't answer straight away", () => {
  test("a device whose storage is a bridge call still opens on last session's records", async () => {
    const entries = new Map<string, string>();
    const async: SyncedStorage = {
      read: async (key) => entries.get(key) ?? null,
      write: async (key, value) => void entries.set(key, value),
      remove: async (key) => void entries.delete(key),
      keys: async () => [...entries.keys()],
    };
    const first = setup({ storage: async });
    const note = first.notes.create(draft);
    await first.client.flush();

    const second = setup({ storage: async, prefix: "test" });
    await second.client.hydrate();
    await second.client.hydrate();
    expect(second.notes.all.map((n) => n.id)).toEqual([note.id]);
  });

  test("an entry an older build wrote is a miss, not a crash", async () => {
    const storage = memoryStorage();
    await storage.write("test:model:notes", "{{{ not json");
    await storage.write("test:queue", "also not json");
    const { client, notes } = setup({ storage });
    await client.hydrate();
    expect(notes.all).toEqual([]);
    expect(client.pendingCount).toBe(0);
  });
});

/**
 * A store whose writes all fail the same way, so the server's two kinds of failure can be told
 * apart. Reads still work: a request that can't even be answered is a different test.
 */
function brokenStore(error: Error): SyncedStore<Note> {
  const fail = async () => {
    throw error;
  };
  return { pull: async () => [], read: async () => null, create: fail, update: fail, remove: fail };
}

function envelope(id: string, updatedAt: number, data: Note): Envelope<Note> {
  return { id, updatedAt, deleted: false, data };
}
