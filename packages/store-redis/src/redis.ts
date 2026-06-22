// The minimal node-redis (v4) surface this adapter uses. `redis` is a PEER
// dependency — the operator installs it; Iris's tree never does. We import it via a
// NON-LITERAL specifier so `tsc` yields `any` (no module resolution, no build-time
// `@types`), and resolve the operator's installed `redis` at run time.
//
// Two node-redis v4 semantics this store RELIES on (and the in-suite fake must mirror):
//   1. `multi().exec()` THROWS a `WatchError` when a watched key changed since `WATCH`
//      (it does NOT return null). We catch it and translate to a closed-union rejection.
//   2. WATCH is connection-scoped, so each optimistic transaction MUST run on its own
//      dedicated connection. node-redis exposes `client.executeIsolated(fn)`, which hands
//      `fn` a checked-out connection; we wrap that as `RedisLike.executeIsolated`.

/** A chainable MULTI builder: queue writes, then `exec()` (throws WatchError on conflict). */
export interface RedisMulti {
  set(key: string, value: string): RedisMulti;
  hSet(key: string, field: string, value: string): RedisMulti;
  hDel(key: string, field: string | string[]): RedisMulti;
  exec(): Promise<unknown>;
}

/** The isolated client handed to `executeIsolated(fn)` — supports WATCH + reads + multi(). */
export interface RedisIsolated {
  watch(key: string | string[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  hGet(key: string, field: string): Promise<string | null | undefined>;
  hGetAll(key: string): Promise<Record<string, string>>;
  multi(): RedisMulti;
}

/** The narrow Redis surface the store/scheduler use — nothing more. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string | string[]): Promise<unknown>;
  hGet(key: string, field: string): Promise<string | null | undefined>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hSet(key: string, field: string, value: string): Promise<unknown>;
  hDel(key: string, field: string | string[]): Promise<unknown>;
  incr(key: string): Promise<number>;
  /** Run `fn` on a DEDICATED connection (WATCH is connection-scoped). */
  executeIsolated<T>(fn: (iso: RedisIsolated) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** True when an error is node-redis's `WatchError` (a watched key changed since WATCH).
 *  node-redis names it "WatchError"; our fake constructs an Error with the same name. */
export function isWatchError(e: unknown): boolean {
  const err = e as { name?: string; code?: string } | null;
  return err?.name === "WatchError" || err?.code === "WatchError";
}

export async function createClient(url: string): Promise<RedisLike> {
  // `name` is annotated `string` (not the literal "redis") so the import() below is not
  // statically resolved by tsc — it types as `any`, and resolves at run time.
  const name: string = "redis";
  let mod: { createClient?: (cfg: { url: string }) => unknown };
  try {
    mod = (await import(name)) as { createClient?: (cfg: { url: string }) => unknown };
  } catch (e) {
    // The common case: the peer dep isn't installed. Translate Node's raw module-not-found
    // into a LOUD, actionable error naming the install command.
    const code = (e as { code?: string }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
      throw new Error("@irisrun/store-redis: the `redis` peer dependency is not installed — run `npm i redis`");
    }
    throw e;
  }
  const create = mod.createClient;
  if (!create) {
    throw new Error("@irisrun/store-redis: `redis` resolved but exposes no createClient — reinstall it (`npm i redis`)");
  }
  // node-redis client: `any` from our perspective (no @types). connect() is required.
  const client = create({ url }) as {
    connect(): Promise<unknown>;
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<unknown>;
    del(key: string | string[]): Promise<unknown>;
    hGet(key: string, field: string): Promise<string | null | undefined>;
    hGetAll(key: string): Promise<Record<string, string>>;
    hSet(key: string, field: string, value: string): Promise<unknown>;
    hDel(key: string, field: string | string[]): Promise<unknown>;
    incr(key: string): Promise<number>;
    executeIsolated<T>(fn: (iso: RedisIsolated) => Promise<T>): Promise<T>;
    quit(): Promise<unknown>;
  };
  await client.connect();
  return {
    get: (key) => client.get(key),
    set: (key, value) => client.set(key, value),
    del: (key) => client.del(key),
    hGet: (key, field) => client.hGet(key, field),
    hGetAll: (key) => client.hGetAll(key),
    hSet: (key, field, value) => client.hSet(key, field, value),
    hDel: (key, field) => client.hDel(key, field),
    incr: (key) => client.incr(key),
    executeIsolated: (fn) => client.executeIsolated(fn),
    close: async () => {
      await client.quit();
    },
  };
}
