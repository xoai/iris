// The narrow Durable Objects storage + alarm abstraction (spec §2.1). The edge
// adapter is written against THIS interface — the subset Cloudflare guarantees —
// not @cloudflare/workers-types (which is not install-free). The real
// DurableObjectState.storage satisfies this shape; the in-suite FakeDoStorage
// (tests/lib/fake-do.ts) implements it over an in-memory Map. The adapter never
// imports @cloudflare/*.
export interface DoStorage {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(opts?: { prefix?: string }): Promise<Map<string, Uint8Array>>;
  // Atomic read-modify-write; the callback runs with exclusive access. On a write
  // conflict the platform retries the txn (Cloudflare semantics). Within ONE DO
  // instance all access is already serialized (single-writer); transaction() makes
  // the compare-and-swap atomic without a check→await→mutate gap.
  transaction<T>(fn: (txn: DoStorage) => Promise<T>): Promise<T>;
  setAlarm(scheduledTime: number): Promise<void>; // DO alarm = durable sleepUntil
  getAlarm(): Promise<number | null>;
}
