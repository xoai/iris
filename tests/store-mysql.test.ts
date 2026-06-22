// @irisrun/store-mysql in-suite unit checks. A SQL-string driver has no faithful
// in-process fake (the real backend interprets the SQL), so — exactly like
// @irisrun/store-postgres — the FULL conformance certification is the env-gated live
// smoke (tests/smoke/store-mysql-smoke.ts). Here we lock the pure, backend-free surface:
// the bootstrap DDL invariants (one statement per entry; `key` backticked; TABLES in sync)
// and the affectedRows→CasResult mapping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BOOTSTRAP_DDL, TABLES, versionedCasResult } from "@irisrun/store-mysql";

test("BOOTSTRAP_DDL is one statement per entry (no ';') — mysql2 prepared protocol rejects multi-statement", () => {
  for (const stmt of BOOTSTRAP_DDL) {
    assert.ok(!stmt.includes(";"), `DDL entry must be a single statement (no ';'): ${stmt}`);
    assert.match(stmt, /^CREATE TABLE IF NOT EXISTS /, `DDL entry must be a CREATE TABLE: ${stmt}`);
  }
});

test("the kv table backticks `key` — it is a MySQL reserved word", () => {
  const kv = BOOTSTRAP_DDL.find((s) => s.includes("iris_kv"))!;
  assert.match(kv, /`key`/, "the `key` column must be backticked in the DDL");
  assert.ok(!/\(key /.test(kv), "an un-backticked `key` would be invalid MySQL DDL");
});

test("every table pins InnoDB + utf8mb4 and uses VARCHAR(191) PK columns", () => {
  for (const stmt of BOOTSTRAP_DDL) {
    assert.match(stmt, /ENGINE=InnoDB DEFAULT CHARSET=utf8mb4/, `missing engine/charset: ${stmt}`);
  }
  // the three string-keyed tables use VARCHAR(191) (under the InnoDB index-byte limit)
  for (const t of ["iris_kv", "iris_meta", "iris_journal", "iris_snapshot"]) {
    const stmt = BOOTSTRAP_DDL.find((s) => s.includes(t))!;
    assert.match(stmt, /VARCHAR\(191\)/, `${t} should key on VARCHAR(191)`);
  }
});

test("TABLES matches the tables declared in BOOTSTRAP_DDL", () => {
  const declared = BOOTSTRAP_DDL.map((s) => s.match(/CREATE TABLE IF NOT EXISTS (\w+)/)![1]).sort();
  assert.deepEqual([...TABLES].sort(), declared);
});

test("versionedCasResult: affectedRows===1 commits at expected+1; otherwise conflicts at current", () => {
  assert.deepEqual(versionedCasResult(1, 4, 4), { ok: true, version: 5 });
  assert.deepEqual(versionedCasResult(0, 4, 7), { ok: false, current: 7 });
});
