// SQLite schema for the Iris reference host adapter. All DDL is idempotent
// (`IF NOT EXISTS`) so opening an existing session file is safe (reversible).
import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS kv (
  key     TEXT PRIMARY KEY,
  bytes   BLOB NOT NULL,
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS journal (
  session_id TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  bytes      BLOB    NOT NULL,
  fence      INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS journal_fence (
  session_id TEXT PRIMARY KEY,
  fence      INTEGER NOT NULL
);

-- Highest seq ever appended per session. Survives truncation so seq numbers
-- are never reused (the density check reads this, not MAX(journal.seq)).
CREATE TABLE IF NOT EXISTS journal_hwm (
  session_id TEXT PRIMARY KEY,
  max_seq    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  session_id TEXT    NOT NULL,
  up_to_seq  INTEGER NOT NULL,
  bytes      BLOB    NOT NULL,
  PRIMARY KEY (session_id, up_to_seq)
);

CREATE TABLE IF NOT EXISTS timers (
  session_id TEXT    NOT NULL,
  wake_at    INTEGER NOT NULL,
  fired      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS signals (
  session_id TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  payload    BLOB,
  delivered  INTEGER NOT NULL DEFAULT 0
);
`;

/** Apply schema + sane pragmas to a database handle. */
export function applySchema(db: DatabaseSync): void {
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA_SQL);
}
