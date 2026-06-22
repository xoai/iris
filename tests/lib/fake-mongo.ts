// FakeMongo — the in-suite stand-in for the `mongodb` driver. Realizes the narrow
// `MongoLike`/`MongoColl` surface over in-memory arrays. It imports NO `mongodb`; it only
// implements the shape MongoStateStore/MongoScheduler call.
//
// CRITICAL: findOneAndUpdate runs the WHOLE match→pipeline-apply→return in ONE synchronous
// tick — no `await` interleave inside it. That mirrors MongoDB's single-document atomicity:
// concurrent calls (driven by the conformance suite's Promise.all) serialize, so exactly
// one matches the `hwm: expectedSeq-1` guard and wins the seq-reserve gate. The methods are
// `async` only so the signatures match the driver; their bodies are synchronous.
//
// It supports just enough query/update grammar for the store: the aggregation-pipeline
// update form ($set with $max/$ifNull computed expressions), classic $set/$inc/$setOnInsert
// + upsert, duplicate _id ⇒ a duplicate-key error (so cas's catch works), find().sort()
// .toArray(), insertMany {ordered:true} (throws on duplicate _id), deleteMany, updateMany.
import type { MongoLike, MongoColl, MongoCursor } from "../../packages/store-mongo/src/mongo.ts";

type Doc = Record<string, unknown>;
type Filter = Record<string, unknown>;
type Update = Record<string, unknown>;
type Pipeline = Array<Record<string, unknown>>;

function dupKeyError(id: unknown): Error {
  const e = new Error(`E11000 duplicate key error: _id ${String(id)}`) as Error & {
    code: number;
    codeName: string;
  };
  e.code = 11000;
  e.codeName = "DuplicateKey";
  return e;
}

/** Match a doc field against a single filter clause value (scalar or operator object). */
function matchClause(actual: unknown, clause: unknown): boolean {
  if (clause !== null && typeof clause === "object" && !Array.isArray(clause)) {
    const ops = clause as Record<string, unknown>;
    for (const [op, val] of Object.entries(ops)) {
      switch (op) {
        case "$lte":
          if (!(Number(actual) <= Number(val))) return false;
          break;
        case "$lt":
          if (!(Number(actual) < Number(val))) return false;
          break;
        case "$gte":
          if (!(Number(actual) >= Number(val))) return false;
          break;
        case "$gt":
          if (!(Number(actual) > Number(val))) return false;
          break;
        default:
          throw new Error(`fake-mongo: unsupported match operator ${op}`);
      }
    }
    return true;
  }
  return actual === clause;
}

/** True if `doc` satisfies every clause in `filter` (supports a top-level $or). */
function matches(doc: Doc, filter: Filter): boolean {
  for (const [field, clause] of Object.entries(filter)) {
    if (field === "$or") {
      const arms = clause as Filter[];
      if (!arms.some((arm) => matches(doc, arm))) return false;
      continue;
    }
    if (!matchClause(doc[field], clause)) return false;
  }
  return true;
}

/** Evaluate an aggregation-pipeline expression against a doc (numbers/strings only). */
function evalExpr(doc: Doc, expr: unknown): unknown {
  if (typeof expr === "string" && expr.startsWith("$")) {
    return doc[expr.slice(1)];
  }
  if (expr !== null && typeof expr === "object" && !Array.isArray(expr)) {
    const obj = expr as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && keys[0].startsWith("$")) {
      const op = keys[0];
      const arg = obj[op];
      switch (op) {
        case "$max": {
          const vals = (arg as unknown[]).map((a) => Number(evalExpr(doc, a)));
          return Math.max(...vals);
        }
        case "$ifNull": {
          const [a, fallback] = arg as [unknown, unknown];
          const v = evalExpr(doc, a);
          return v === undefined || v === null ? evalExpr(doc, fallback) : v;
        }
        default:
          throw new Error(`fake-mongo: unsupported pipeline expression ${op}`);
      }
    }
  }
  return expr; // a literal
}

/** Apply a $set stage's computed fields (pipeline form) to a doc, in place. */
function applyPipelineSet(doc: Doc, setSpec: Record<string, unknown>): void {
  for (const [field, expr] of Object.entries(setSpec)) {
    doc[field] = evalExpr(doc, expr);
  }
}

/** Apply a classic update ($set/$inc/$setOnInsert) to a doc, in place. `isInsert`
 *  controls whether $setOnInsert applies. */
function applyClassicUpdate(doc: Doc, update: Update, isInsert: boolean): void {
  for (const [op, spec] of Object.entries(update)) {
    const fields = spec as Record<string, unknown>;
    switch (op) {
      case "$set":
        for (const [f, v] of Object.entries(fields)) doc[f] = v;
        break;
      case "$inc":
        for (const [f, v] of Object.entries(fields)) doc[f] = Number(doc[f] ?? 0) + Number(v);
        break;
      case "$setOnInsert":
        if (isInsert) for (const [f, v] of Object.entries(fields)) doc[f] = v;
        break;
      default:
        throw new Error(`fake-mongo: unsupported update operator ${op}`);
    }
  }
}

function isPipeline(update: Update | Pipeline): update is Pipeline {
  return Array.isArray(update);
}

/** Apply an update (pipeline or classic) to a doc, in place. */
function applyUpdate(doc: Doc, update: Update | Pipeline, isInsert: boolean): void {
  if (isPipeline(update)) {
    for (const stage of update) {
      const set = (stage as Record<string, unknown>).$set;
      if (!set) throw new Error("fake-mongo: only $set stages are supported in pipelines");
      applyPipelineSet(doc, set as Record<string, unknown>);
    }
  } else {
    applyClassicUpdate(doc, update, isInsert);
  }
}

class FakeColl implements MongoColl {
  private readonly docs: Doc[] = [];

  async findOne(filter: Filter): Promise<Doc | null> {
    const d = this.docs.find((x) => matches(x, filter));
    return d ? { ...d } : null;
  }

  find(filter: Filter): MongoCursor {
    const rows = this.docs.filter((x) => matches(x, filter)).map((x) => ({ ...x }));
    return {
      sort(spec: Record<string, 1 | -1>) {
        const [[field, dir]] = Object.entries(spec);
        const sorted = [...rows].sort((a, b) => {
          const av = a[field] as number | string;
          const bv = b[field] as number | string;
          if (av < bv) return -1 * dir;
          if (av > bv) return 1 * dir;
          return 0;
        });
        return { toArray: async () => sorted };
      },
    };
  }

  async insertOne(doc: Doc): Promise<unknown> {
    if (doc._id !== undefined && this.docs.some((x) => x._id === doc._id)) throw dupKeyError(doc._id);
    this.docs.push({ ...doc });
    return { insertedId: doc._id };
  }

  async insertMany(docs: Doc[], _opts?: { ordered?: boolean }): Promise<unknown> {
    // ordered: insert one-by-one, throw on the first duplicate (those before it persist —
    // matching mongo's ordered semantics). The store only inserts a freshly-reserved range,
    // so duplicates never occur in practice.
    for (const doc of docs) {
      if (doc._id !== undefined && this.docs.some((x) => x._id === doc._id)) throw dupKeyError(doc._id);
      this.docs.push({ ...doc });
    }
    return { insertedCount: docs.length };
  }

  async updateOne(
    filter: Filter,
    update: Update | Pipeline,
    opts?: { upsert?: boolean },
  ): Promise<{ matchedCount: number }> {
    const target = this.docs.find((x) => matches(x, filter));
    if (target) {
      applyUpdate(target, update, false);
      return { matchedCount: 1 };
    }
    if (opts?.upsert) {
      // Seed the new doc with the equality fields from the filter (the _id, etc.).
      const seed: Doc = {};
      for (const [f, clause] of Object.entries(filter)) {
        if (clause === null || typeof clause !== "object") seed[f] = clause;
      }
      applyUpdate(seed, update, true);
      if (seed._id !== undefined && this.docs.some((x) => x._id === seed._id)) throw dupKeyError(seed._id);
      this.docs.push(seed);
    }
    return { matchedCount: 0 };
  }

  async updateMany(filter: Filter, update: Update | Pipeline): Promise<unknown> {
    let n = 0;
    for (const doc of this.docs) {
      if (matches(doc, filter)) {
        applyUpdate(doc, update, false);
        n += 1;
      }
    }
    return { matchedCount: n };
  }

  // ATOMIC: the whole match→apply→return runs in ONE synchronous tick (no await inside),
  // so concurrent calls serialize and exactly one matches a single-doc guard.
  async findOneAndUpdate(
    filter: Filter,
    update: Update | Pipeline,
    opts?: { returnDocument?: "after" | "before"; upsert?: boolean },
  ): Promise<Doc | null> {
    const target = this.docs.find((x) => matches(x, filter));
    if (!target) {
      if (opts?.upsert) {
        const seed: Doc = {};
        for (const [f, clause] of Object.entries(filter)) {
          if (clause === null || typeof clause !== "object") seed[f] = clause;
        }
        applyUpdate(seed, update, true);
        this.docs.push(seed);
        return opts?.returnDocument === "after" ? { ...seed } : null;
      }
      return null;
    }
    const before = { ...target };
    applyUpdate(target, update, false);
    return opts?.returnDocument === "after" ? { ...target } : before;
  }

  async deleteMany(filter: Filter): Promise<unknown> {
    let n = 0;
    for (let i = this.docs.length - 1; i >= 0; i--) {
      if (matches(this.docs[i], filter)) {
        this.docs.splice(i, 1);
        n += 1;
      }
    }
    return { deletedCount: n };
  }
}

class FakeDb implements MongoLike {
  private readonly colls = new Map<string, FakeColl>();
  collection(name: string): MongoColl {
    let c = this.colls.get(name);
    if (!c) {
      c = new FakeColl();
      this.colls.set(name, c);
    }
    return c;
  }
}

/** A fresh in-memory MongoLike. Each conformance factory call gets its own clean db. */
export function makeFakeMongo(): MongoLike {
  return new FakeDb();
}
