/**
 * What the client and the server say to each other about a set of records.
 *
 * One request carries every model at once — the queue of what the user did since the last round
 * trip, and how fresh their copy of each model is. One response carries the server's answer to
 * both: which of those writes landed, and everything that changed for anyone else meanwhile.
 * Batching them means a screen's writes and its reads can't disagree about what the server said,
 * and a burst of edits costs one request rather than one per edit.
 */

/** The identity every synced record has to carry, so a write can name what it changed. */
export interface Identified {
  readonly id: string;
}

/**
 * A record as the server knows it: its data, when the server last wrote it, and whether that
 * write was a deletion. Deletions travel as tombstones rather than absences — a client that has
 * been away has no other way to tell "gone" from "never seen".
 */
export interface Envelope<T extends Identified = Identified> {
  readonly id: string;
  /** Server clock, milliseconds. The only clock either side compares against. */
  readonly updatedAt: number;
  readonly deleted: boolean;
  /** Absent for a tombstone — there's nothing left to describe. */
  readonly data: T | null;
}

/**
 * Something the user did, before it's been given an identity to retry under.
 *
 * `update` carries only the fields that were touched, so two devices editing different fields of
 * one record merge instead of one erasing the other. `action` is the escape hatch: a write whose
 * meaning the server owns — sending the reply to an invitation, archiving a thread in Gmail,
 * moving a page in Notion — with the client saying only what the screen should show meanwhile.
 */
export type Intent<T extends Identified = Identified> =
  | { readonly kind: "create"; readonly model: string; readonly id: string; readonly data: T }
  | { readonly kind: "update"; readonly model: string; readonly id: string; readonly patch: Partial<T> }
  | { readonly kind: "delete"; readonly model: string; readonly id: string }
  | {
      readonly kind: "action";
      readonly model: string;
      readonly id: string;
      readonly name: string;
      readonly payload: unknown;
    };

/**
 * An intent on its way to the server, named by an id the client makes up so the server can
 * recognise the same write arriving twice. Retries are the normal case, not the exception: a
 * reply lost to a dropped connection is indistinguishable from a request that never arrived.
 */
export type Mutation<T extends Identified = Identified> = Intent<T> & { readonly mutationId: string };

export interface SyncRequest {
  /** Per model, the newest `updatedAt` this client already holds. Absent model = never synced. */
  readonly since: Readonly<Record<string, number>>;
  readonly mutations: readonly Mutation[];
}

export interface SyncResponse {
  /** Per model, every record written at or after the client's `since`, tombstones included. */
  readonly changes: Readonly<Record<string, readonly Envelope[]>>;
  /** Per model, what the client should send as `since` next time. */
  readonly since: Readonly<Record<string, number>>;
  /** Mutations the server has durably applied — the client can forget them. */
  readonly applied: readonly string[];
  /** Mutations the server will never apply. The client drops them and shows the reason. */
  readonly rejected: readonly RejectedMutation[];
}

export interface RejectedMutation {
  readonly mutationId: string;
  readonly reason: string;
}
