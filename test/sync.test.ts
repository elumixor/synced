import { beforeEach, describe, expect, test } from "bun:test";
import { memoryStorage } from "../src/client";
import { draft, makeServer, Network, pinCounts, setup } from "./harness";

beforeEach(() => pinCounts.clear());

describe("optimism", () => {
  test("a new record is on screen before the request is even sent", () => {
    const { notes, client } = setup();
    notes.create(draft);
    expect(notes.all.map((note) => note.title)).toEqual(["Groceries"]);
    expect(client.pendingCount).toBe(1);
  });

  test("the record stays put once the server confirms it", async () => {
    const { notes, client } = setup();
    const created = notes.create(draft);
    await client.flush();
    expect(client.pendingCount).toBe(0);
    expect(notes.all).toEqual([{ ...draft, id: created.id }]);
  });

  test("assigning to a field writes only that field", async () => {
    const { notes, client, store } = setup();
    const created = notes.create(draft);
    await client.flush();
    const note = notes.get(created.id);
    if (!note) throw new Error("expected the note to be on screen");
    note.body = "milk, bread";
    expect(notes.all[0]?.body).toBe("milk, bread");
    await client.flush();
    expect(await store.read("u1", created.id)).toEqual({ ...draft, id: created.id, body: "milk, bread" });
  });

  test("a write the server refuses snaps the screen back and says why", async () => {
    const { notes, client, rejections } = setup();
    notes.create({ ...draft, title: "" });
    expect(notes.all).toHaveLength(1);
    await client.flush();
    expect(notes.all).toEqual([]);
    expect(client.pendingCount).toBe(0);
    expect(rejections[0]).toContain("title");
  });

  test("a read-only record is refused without touching the rest of the batch", async () => {
    const { notes, client, store, rejections } = setup();
    await store.put("u1", { id: "sys", title: "system", body: "", pinned: false });
    await client.sync();
    notes.update("sys", { body: "mine now" });
    const mine = notes.create(draft);
    await client.flush();
    expect(rejections).toEqual(["This notes record is read-only."]);
    expect(notes.all.find((note) => note.id === "sys")?.body).toBe("");
    expect(notes.all.find((note) => note.id === mine.id)).toBeDefined();
  });
});

describe("reconciliation", () => {
  test("a response landing mid-edit doesn't overwrite the edit", async () => {
    const { notes, client, store } = setup();
    const created = notes.create(draft);
    await client.flush();

    // Another device renames it, and the pull that brings that back is already on its way when
    // this one starts typing.
    await store.put("u1", { ...draft, id: created.id, title: "Shopping" });
    const pulling = client.sync();
    notes.update(created.id, { body: "milk, bread" });
    await pulling;

    expect(notes.all[0]).toEqual({ id: created.id, title: "Shopping", body: "milk, bread", pinned: false });
    await client.flush();
    expect(await store.read("u1", created.id)).toEqual({
      id: created.id,
      title: "Shopping",
      body: "milk, bread",
      pinned: false,
    });
  });

  test("two devices editing different fields both survive", async () => {
    const shared = makeServer();
    const network = new Network(shared.server);
    const one = setup({ server: shared, network });
    const two = setup({ server: shared, network });
    const created = one.notes.create(draft);
    await one.client.flush();
    await two.client.sync();

    one.notes.update(created.id, { title: "Errands" });
    two.notes.update(created.id, { body: "milk, bread" });
    await one.client.flush();
    await two.client.flush();
    await one.client.sync();

    expect(one.notes.all[0]).toEqual({ id: created.id, title: "Errands", body: "milk, bread", pinned: false });
  });

  test("a delete on one device reaches the other as a tombstone", async () => {
    const shared = makeServer();
    const network = new Network(shared.server);
    const one = setup({ server: shared, network });
    const two = setup({ server: shared, network });
    const created = one.notes.create(draft);
    await one.client.flush();
    await two.client.sync();
    expect(two.notes.all).toHaveLength(1);

    one.notes.delete(created.id);
    await one.client.flush();
    await two.client.sync();
    expect(two.notes.all).toEqual([]);
  });
});

describe("delivery", () => {
  test("a reply lost in transit doesn't apply the write twice", async () => {
    const { notes, client, network, store } = setup();
    network.loseNextReply = true;
    const created = notes.create(draft);
    await client.flush();

    // The server took the write and the client never heard so — so it sent it again.
    expect(network.requests).toBeGreaterThan(1);
    expect(client.pendingCount).toBe(0);
    expect(await store.pull("u1", 0)).toHaveLength(1);
    expect(notes.all).toEqual([{ ...draft, id: created.id }]);
  });

  test("an action that was already run isn't run again on retry", async () => {
    const { notes, client, network } = setup();
    const created = notes.create(draft);
    await client.flush();
    network.loseNextReply = true;
    notes.act("pin", created.id, { pinned: true });
    expect(notes.all[0]?.pinned).toBe(true);
    await client.flush();
    await client.flush();
    expect(pinCounts.get(created.id)).toBe(1);
    expect(notes.all[0]?.pinned).toBe(true);
  });

  test("a burst of offline edits goes up as one request", async () => {
    const { notes, client, network } = setup();
    network.offline = true;
    const created = notes.create(draft);
    await client.flush();
    for (const body of ["a", "ab", "abc", "abcd"]) notes.update(created.id, { body });
    expect(notes.all[0]?.body).toBe("abcd");

    network.offline = false;
    const before = network.requests;
    await client.flush();
    expect(network.requests - before).toBe(1);
    expect(client.pendingCount).toBe(0);
  });

  test("a slider dragged across the screen is one write, not two hundred", async () => {
    const { notes, client, network } = setup();
    const created = notes.create(draft);
    await client.flush();
    network.offline = true;
    for (let step = 0; step < 50; step++) notes.update(created.id, { body: `${step}` });
    // One write for whatever a round in flight already took, one for everything since.
    expect(client.pendingCount).toBeLessThanOrEqual(2);

    network.offline = false;
    await client.flush();
    expect(notes.all[0]?.body).toBe("49");
  });

  test("a step that spans a drag is one press of undo", async () => {
    const { notes, client } = setup();
    const created = notes.create(draft);
    await client.flush();

    client.beginStep();
    for (const title of ["A", "AB", "ABC"]) notes.update(created.id, { title });
    client.commitStep();
    expect(notes.all[0]?.title).toBe("ABC");
    client.undo();
    expect(notes.all[0]?.title).toBe("Groceries");
  });

  test("the first screen to ask pays for the round trip; the rest read what it left", async () => {
    const { client, network } = setup();
    await Promise.all([client.ensure(), client.ensure()]);
    await client.ensure();
    expect(network.requests).toBe(1);
  });

  test("failures back off, and the queue lands once the network is back", async () => {
    const { notes, client, network, runtime } = setup();
    network.offline = true;
    notes.create(draft);
    await client.flush();
    expect(runtime.delays()).toEqual([750]);

    await runtime.settle();
    expect(runtime.delays()).toEqual([1500]);

    network.offline = false;
    await runtime.settle();
    expect(client.pendingCount).toBe(0);
    expect(client.error).toBeNull();
  });

  test("unsent writes survive the app being killed", async () => {
    const storage = memoryStorage();
    const shared = makeServer();
    const network = new Network(shared.server);
    const first = setup({ server: shared, network, storage, prefix: "device" });
    network.offline = true;
    const created = first.notes.create(draft);
    await first.client.flush();

    const second = setup({ server: shared, network, storage, prefix: "device" });
    await second.client.hydrate();
    expect(second.client.pendingCount).toBe(1);
    expect(second.notes.all).toEqual([{ ...draft, id: created.id }]);

    network.offline = false;
    await second.client.flush();
    expect(await shared.store.read("u1", created.id)).toEqual({ ...draft, id: created.id });
  });

  test("records from last session are on screen before the first request", async () => {
    const storage = memoryStorage();
    const shared = makeServer();
    const network = new Network(shared.server);
    const first = setup({ server: shared, network, storage, prefix: "device" });
    const created = first.notes.create(draft);
    await first.client.flush();

    const second = setup({ server: shared, network, storage, prefix: "device" });
    network.offline = true;
    await second.client.hydrate();
    expect(second.notes.all).toEqual([{ ...draft, id: created.id }]);
  });
});

describe("undo", () => {
  test("undoing a new record takes it off the server too", async () => {
    const { notes, client, store } = setup();
    const created = notes.create(draft);
    await client.flush();

    client.undo();
    expect(notes.all).toEqual([]);
    await client.flush();
    expect(await store.read("u1", created.id)).toBeNull();

    client.redo();
    await client.flush();
    expect(notes.all).toEqual([{ ...draft, id: created.id }]);
  });

  test("undoing an edit puts the previous value back, not the whole record", async () => {
    const { notes, client } = setup();
    const created = notes.create(draft);
    await client.flush();
    notes.update(created.id, { title: "Errands" });
    notes.update(created.id, { body: "milk, bread" });
    await client.flush();

    client.undo();
    expect(notes.all[0]).toEqual({ id: created.id, title: "Errands", body: "milk", pinned: false });
    client.undo();
    expect(notes.all[0]).toEqual({ ...draft, id: created.id });
    client.redo();
    expect(notes.all[0]?.title).toBe("Errands");
  });

  test("a burst wrapped in a transaction is one press of undo", async () => {
    const { notes, client } = setup();
    const created = notes.create(draft);
    await client.flush();

    client.transaction(() => {
      notes.update(created.id, { title: "Errands" });
      notes.update(created.id, { body: "bread" });
    });
    expect(notes.all[0]).toEqual({ id: created.id, title: "Errands", body: "bread", pinned: false });
    client.undo();
    expect(notes.all[0]).toEqual({ ...draft, id: created.id });
    client.redo();
    expect(notes.all[0]).toEqual({ id: created.id, title: "Errands", body: "bread", pinned: false });
  });

  test("undoing a delete brings the record back", async () => {
    const { notes, client, store } = setup();
    const created = notes.create(draft);
    await client.flush();
    notes.delete(created.id);
    await client.flush();

    client.undo();
    await client.flush();
    expect(notes.all).toEqual([{ ...draft, id: created.id }]);
    expect(await store.read("u1", created.id)).toEqual({ ...draft, id: created.id });
  });

  test("undoing a server-owned action runs the write the model says undoes it", async () => {
    const { notes, client, store } = setup();
    const created = notes.create(draft);
    await client.flush();
    notes.act("pin", created.id, { pinned: true });
    await client.flush();
    expect((await store.read("u1", created.id))?.pinned).toBe(true);

    client.undo();
    expect(notes.all[0]?.pinned).toBe(false);
    await client.flush();
    expect((await store.read("u1", created.id))?.pinned).toBe(false);
  });

  test("signing out forgets the records, the queue and the history", async () => {
    const { notes, client, storage } = setup();
    notes.create(draft);
    await client.flush();
    await client.clear();
    expect(notes.all).toEqual([]);
    expect(client.pendingCount).toBe(0);
    expect(client.history.canUndo).toBe(false);
    expect(await storage.keys()).toEqual([]);
  });
});
