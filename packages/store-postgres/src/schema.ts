// First-boot schema. ONE statement per array entry — pg's extended (prepared) protocol
// rejects a multi-statement string in a single query, so `openStore` loops these. The
// `iris_meta.hwm` is the high-water mark that SURVIVES truncation (so seq numbers are
// never reused), and `iris_meta` is the per-session row `append` locks `FOR UPDATE` to
// linearize concurrent writers.
export const BOOTSTRAP_DDL: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS iris_kv (key text PRIMARY KEY, version bigint NOT NULL, bytes bytea NOT NULL)",
  "CREATE TABLE IF NOT EXISTS iris_meta (session text PRIMARY KEY, hwm bigint NOT NULL, fence bigint NOT NULL)",
  "CREATE TABLE IF NOT EXISTS iris_journal (session text NOT NULL, seq bigint NOT NULL, bytes bytea NOT NULL, fence bigint NOT NULL, PRIMARY KEY (session, seq))",
  "CREATE TABLE IF NOT EXISTS iris_snapshot (session text NOT NULL, upto_seq bigint NOT NULL, bytes bytea NOT NULL, PRIMARY KEY (session, upto_seq))",
  "CREATE TABLE IF NOT EXISTS iris_wakeup (id bigserial PRIMARY KEY, session text NOT NULL, kind text NOT NULL, name text, wake_at bigint, fired boolean NOT NULL DEFAULT false)",
];

/** Table names, for a smoke's drop/recreate teardown. */
export const TABLES: readonly string[] = ["iris_kv", "iris_meta", "iris_journal", "iris_snapshot", "iris_wakeup"];
