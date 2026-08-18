/**
 * Where a collection's copy of the server's answer, and the writes not yet acknowledged, are kept
 * between launches.
 *
 * Asynchronous because a phone's storage is: Capacitor's `Preferences` is a bridge call. Web
 * storage isn't, and a cold start that has to wait a tick before it can draw is a blank first
 * frame — so an adapter that can answer immediately says so with `readSync`.
 */
export interface SyncedStorage {
  readSync?(key: string): string | null;
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Every key this adapter wrote, so signing out can take all of them. */
  keys(): Promise<readonly string[]>;
}

export function memoryStorage(): SyncedStorage {
  const entries = new Map<string, string>();
  return {
    readSync: (key) => entries.get(key) ?? null,
    read: async (key) => entries.get(key) ?? null,
    write: async (key, value) => void entries.set(key, value),
    remove: async (key) => void entries.delete(key),
    keys: async () => [...entries.keys()],
  };
}
