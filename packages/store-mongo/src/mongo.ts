// The minimal `mongodb` surface this adapter uses. `mongodb` is a PEER dependency —
// the operator installs it; Iris's tree never does. We import it via a NON-LITERAL
// specifier so `tsc` yields `any` (no module resolution, no build-time dep on the
// driver's types), and resolve the operator's installed `mongodb` at run time.
//
// The interfaces below are intentionally narrow: only the collection methods the store
// and scheduler call. They are structurally satisfied by both the real driver's
// `Collection` and the in-suite fake (`tests/lib/fake-mongo.ts`).

/** A find() cursor — only the chained `sort()→toArray()` the store relies on. */
export interface MongoCursor {
  sort(spec: Record<string, 1 | -1>): { toArray(): Promise<Array<Record<string, unknown>>> };
}

/** The narrow Collection surface — atomic single-doc ops plus query helpers. */
export interface MongoColl {
  findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  find(filter: Record<string, unknown>): MongoCursor;
  insertOne(doc: Record<string, unknown>): Promise<unknown>;
  insertMany(docs: Array<Record<string, unknown>>, opts?: { ordered?: boolean }): Promise<unknown>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown> | Array<Record<string, unknown>>,
    opts?: { upsert?: boolean },
  ): Promise<{ matchedCount: number }>;
  updateMany(
    filter: Record<string, unknown>,
    update: Record<string, unknown> | Array<Record<string, unknown>>,
  ): Promise<unknown>;
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown> | Array<Record<string, unknown>>,
    opts?: { returnDocument?: "after" | "before"; upsert?: boolean },
  ): Promise<Record<string, unknown> | null>;
  deleteMany(filter: Record<string, unknown>): Promise<unknown>;
}

/** The narrow database surface — just collection lookup. */
export interface MongoLike {
  collection(name: string): MongoColl;
}

/** True for a duplicate-key (E11000 / code 11000) error — `cas`/`insertMany` catch it. */
export function isDuplicateKey(e: unknown): boolean {
  const err = e as { code?: number; codeName?: string; name?: string };
  return err?.code === 11000 || err?.codeName === "DuplicateKey" || err?.name === "MongoBulkWriteError";
}

/** Round-trip helpers. We store raw bytes as a Buffer; on read the driver yields a BSON
 *  Binary (`.buffer`), and the fake yields a Uint8Array — normalize both to Uint8Array. */
export const toBuf = (u8: Uint8Array): Buffer => Buffer.from(u8);
export const toU8 = (b: unknown): Uint8Array => {
  if (b instanceof Uint8Array) return new Uint8Array(b);
  // BSON Binary exposes the bytes on `.buffer`.
  const bin = b as { buffer?: ArrayBufferView | ArrayBuffer };
  if (bin?.buffer) return new Uint8Array(bin.buffer as ArrayBuffer);
  return new Uint8Array(b as ArrayBuffer);
};

/** Derive the DB name from a mongodb:// URL path (`/agents` → `agents`), else `iris`. */
export function dbNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/^\//, "");
    return path.length > 0 ? path : "iris";
  } catch {
    return "iris";
  }
}

interface MongoClientLike {
  connect(): Promise<unknown>;
  db(name?: string): MongoLike;
  close(): Promise<void>;
}
type MongoClientCtor = new (url: string) => MongoClientLike;

/** Connect to MongoDB; returns the narrow DB handle plus a close(). */
export async function connect(url: string): Promise<{ db: MongoLike; close(): Promise<void> }> {
  // `name` is annotated `string` (not the literal "mongodb") so the import() below is not
  // statically resolved by tsc — it types as `any`, and resolves at run time.
  const name: string = "mongodb";
  let mod: { MongoClient?: MongoClientCtor; default?: { MongoClient?: MongoClientCtor } };
  try {
    mod = (await import(name)) as { MongoClient?: MongoClientCtor; default?: { MongoClient?: MongoClientCtor } };
  } catch (e) {
    // The common case: the peer dep isn't installed. Translate Node's raw module-not-found
    // into a LOUD, actionable error naming the install command.
    const code = (e as { code?: string }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
      throw new Error("@irisrun/store-mongo: the `mongodb` peer dependency is not installed — run `npm i mongodb`");
    }
    throw e;
  }
  const Ctor = mod.MongoClient ?? mod.default?.MongoClient;
  if (!Ctor) {
    throw new Error("@irisrun/store-mongo: `mongodb` resolved but exposes no MongoClient — reinstall it (`npm i mongodb`)");
  }
  const client = new Ctor(url);
  await client.connect();
  const db = client.db(dbNameFromUrl(url));
  return { db, close: () => client.close() };
}
