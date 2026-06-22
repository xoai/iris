// First-boot schema. ONE statement per array entry — mysql2's prepared protocol rejects a
// multi-statement string in a single query, so `openStore` loops these. Notes:
//   • `key` is a MySQL RESERVED WORD — it MUST be backticked everywhere (DDL and DML).
//   • String PK columns are VARCHAR(191) so the utf8mb4 index stays under InnoDB's
//     767/3072-byte key limit on older servers; ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
//     is pinned so the schema is portable across MySQL/MariaDB defaults.
//   • `iris_meta.hwm` is the high-water mark that SURVIVES truncation (seqs are never
//     reused), and is the per-session row `append` locks `FOR UPDATE` to linearize writers.
export const BOOTSTRAP_DDL: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS iris_kv (`key` VARCHAR(191) PRIMARY KEY, version BIGINT NOT NULL, bytes LONGBLOB NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS iris_meta (session VARCHAR(191) PRIMARY KEY, hwm BIGINT NOT NULL, fence BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS iris_journal (session VARCHAR(191) NOT NULL, seq BIGINT NOT NULL, bytes LONGBLOB NOT NULL, fence BIGINT NOT NULL, PRIMARY KEY (session, seq)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS iris_snapshot (session VARCHAR(191) NOT NULL, upto_seq BIGINT NOT NULL, bytes LONGBLOB NOT NULL, PRIMARY KEY (session, upto_seq)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS iris_wakeup (id BIGINT AUTO_INCREMENT PRIMARY KEY, session VARCHAR(191) NOT NULL, kind VARCHAR(16) NOT NULL, name VARCHAR(191), wake_at BIGINT, fired TINYINT(1) NOT NULL DEFAULT 0) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
];

/** Table names, for a smoke's drop/recreate teardown. */
export const TABLES: readonly string[] = ["iris_kv", "iris_meta", "iris_journal", "iris_snapshot", "iris_wakeup"];
