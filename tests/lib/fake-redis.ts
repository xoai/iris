// FakeRedis — the in-suite stand-in for node-redis (v4), realizing the narrow `RedisLike`
// over in-memory Maps with FAITHFUL optimistic-transaction semantics:
//   • every key carries a version counter, bumped on every mutating write;
//   • executeIsolated(fn) runs fn against an isolated view that SNAPSHOTS each watched
//     key's version at watch() time;
//   • multi().exec() THROWS a `WatchError` (an Error whose `name` matches the createClient
//     wrapper's isWatchError detector) if ANY watched key's version moved since watch();
//     otherwise it applies the queued mutations ATOMICALLY — synchronously, in one tick,
//     with NO await between the version re-check and the apply, so two concurrent
//     transactions cannot interleave their check→apply. That is exactly what yields
//     "exactly one winner" under Promise.all concurrency (the live-Redis WATCH guarantee).
// It imports NO `redis` — it only realizes the RedisLike shape the store/scheduler use.
import type { RedisLike, RedisIsolated, RedisMulti } from "@irisrun/store-redis";

class WatchError extends Error {
  // node-redis names its error "WatchError"; isWatchError() matches on this name.
  override name = "WatchError";
  constructor() {
    super("One (or more) of the watched keys has been changed");
  }
}

type Hash = Map<string, string>;

interface Store {
  // A key is either a string value or a hash. We track a version per key, bumped on write.
  strings: Map<string, string>;
  hashes: Map<string, Hash>;
  versions: Map<string, number>;
}

function bump(store: Store, key: string): void {
  store.versions.set(key, (store.versions.get(key) ?? 0) + 1);
}

// A queued mutation, applied atomically inside exec() once the watch-versions still hold.
type Mutation = (store: Store) => void;

function makeMulti(store: Store, watched: Map<string, number>): RedisMulti {
  const ops: Mutation[] = [];
  const builder: RedisMulti = {
    set(key, value) {
      ops.push((s) => {
        s.strings.set(key, value);
        bump(s, key);
      });
      return builder;
    },
    hSet(key, field, value) {
      ops.push((s) => {
        let h = s.hashes.get(key);
        if (!h) {
          h = new Map();
          s.hashes.set(key, h);
        }
        h.set(field, value);
        bump(s, key);
      });
      return builder;
    },
    hDel(key, field) {
      const fields = Array.isArray(field) ? field : [field];
      ops.push((s) => {
        const h = s.hashes.get(key);
        if (h) for (const f of fields) h.delete(f);
        bump(s, key);
      });
      return builder;
    },
    async exec() {
      // ATOMIC commit: re-check every watched key's version, then apply — all synchronous,
      // no await in between, so concurrent execs are serialized by the JS event loop.
      for (const [key, ver] of watched) {
        if ((store.versions.get(key) ?? 0) !== ver) throw new WatchError();
      }
      for (const op of ops) op(store);
      return [];
    },
  };
  return builder;
}

function makeIsolated(store: Store): RedisIsolated {
  const watched = new Map<string, number>();
  return {
    async watch(key) {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) watched.set(k, store.versions.get(k) ?? 0);
    },
    async get(key) {
      return store.strings.get(key) ?? null;
    },
    async hGet(key, field) {
      return store.hashes.get(key)?.get(field) ?? null;
    },
    async hGetAll(key) {
      const h = store.hashes.get(key);
      return h ? Object.fromEntries(h) : {};
    },
    multi() {
      return makeMulti(store, watched);
    },
  };
}

export function makeFakeRedis(): RedisLike {
  const store: Store = { strings: new Map(), hashes: new Map(), versions: new Map() };
  let counter = 0;
  return {
    async get(key) {
      return store.strings.get(key) ?? null;
    },
    async set(key, value) {
      store.strings.set(key, value);
      bump(store, key);
      return "OK";
    },
    async del(key) {
      const keys = Array.isArray(key) ? key : [key];
      let n = 0;
      for (const k of keys) {
        if (store.strings.delete(k) || store.hashes.delete(k)) n += 1;
        bump(store, k);
      }
      return n;
    },
    async hGet(key, field) {
      return store.hashes.get(key)?.get(field) ?? null;
    },
    async hGetAll(key) {
      const h = store.hashes.get(key);
      return h ? Object.fromEntries(h) : {};
    },
    async hSet(key, field, value) {
      let h = store.hashes.get(key);
      if (!h) {
        h = new Map();
        store.hashes.set(key, h);
      }
      h.set(field, value);
      bump(store, key);
      return 1;
    },
    async hDel(key, field) {
      const fields = Array.isArray(field) ? field : [field];
      const h = store.hashes.get(key);
      let n = 0;
      if (h) for (const f of fields) if (h.delete(f)) n += 1;
      bump(store, key);
      return n;
    },
    async incr(key) {
      counter = Number(store.strings.get(key) ?? "0") + 1;
      store.strings.set(key, String(counter));
      bump(store, key);
      return counter;
    },
    async executeIsolated(fn) {
      // A fresh isolated view per call (its own watch-version snapshot) — a dedicated
      // connection's worth of WATCH scope, as node-redis's executeIsolated provides.
      return fn(makeIsolated(store));
    },
    async close() {
      // no-op for the in-memory fake
    },
  };
}
