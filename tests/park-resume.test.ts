import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import * as core from "@iris/core";
import { decode } from "@iris/core";
import type { JournalRecord, Marker } from "@iris/core";
import { openDatabase, SqliteStateStore } from "@iris/store-sqlite";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUN = join(ROOT, "packages", "demo", "src", "run.ts");

function runChild(args: string[]): { status: string; output?: unknown; wait?: unknown } {
  // Each call is a SEPARATE Node process — no shared memory; state lives only
  // in the SQLite file.
  const stdout = execFileSync("node", [RUN, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env },
  });
  const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "{}";
  return JSON.parse(line);
}

test("A3: same agent parks in one process and resumes in a fresh process from SQLite", () => {
  const dbPath = join(
    tmpdir(),
    `iris-park-resume-${process.pid}-${globalThis.performance.now().toString().replace(".", "")}.sqlite`,
  );
  const sid = "cross-restart";
  try {
    // --- process #1: run a turn → parks on the timer, then exits ---
    const t1 = runChild(["--session", sid, "--db", dbPath]);
    assert.equal(t1.status, "parked");
    assert.deepEqual(t1.wait, { kind: "timer", at: 10 });

    // --- process #2: a FRESH node process resumes purely from the file ---
    const t2 = runChild([
      "--session",
      sid,
      "--db",
      dbPath,
      "--resume",
      "--now",
      "100",
    ]);
    assert.equal(t2.status, "finished");
    assert.deepEqual(t2.output, { counter: 2, echoed: { counter: 1 } });
  } finally {
    for (const ext of ["", "-journal", "-wal", "-shm"]) {
      try {
        rmSync(dbPath + ext);
      } catch {
        /* ignore */
      }
    }
  }
});

test("A3: the resumed journal is coherent (wait marker before the restart, finish after)", async () => {
  const dbPath = join(
    tmpdir(),
    `iris-park-journal-${process.pid}-${globalThis.performance.now().toString().replace(".", "")}.sqlite`,
  );
  const sid = "cross-restart-2";
  try {
    runChild(["--session", sid, "--db", dbPath]);
    const store = new SqliteStateStore(openDatabase(dbPath));
    const afterPark = (await store.readJournal(sid, 0)).map(
      (r) => decode(r.bytes) as unknown as JournalRecord,
    );
    const kindsAfterPark = afterPark.map((r) => r.kind);
    assert.ok(
      kindsAfterPark.includes("marker"),
      "expected a wait marker after parking",
    );
    assert.ok(
      !afterPark.some(
        (r) => r.kind === "marker" && (r.payload as Marker).marker === "finish",
      ),
      "must not be finished before resume",
    );

    runChild(["--session", sid, "--db", dbPath, "--resume", "--now", "100"]);
    const afterFinish = (await store.readJournal(sid, 0)).map(
      (r) => decode(r.bytes) as unknown as JournalRecord,
    );
    assert.ok(
      afterFinish.some(
        (r) => r.kind === "marker" && (r.payload as Marker).marker === "finish",
      ),
      "expected a finish marker after resume",
    );
  } finally {
    for (const ext of ["", "-journal", "-wal", "-shm"]) {
      try {
        rmSync(dbPath + ext);
      } catch {
        /* ignore */
      }
    }
  }
});

test("A3: core holds no module-level mutable session state (resume works purely from disk)", () => {
  // The cross-process resume above is the real proof. As a structural guard,
  // @iris/core's surface is functions/classes only — no session registry,
  // arrays, maps, or other mutable session containers at module scope.
  const sessionishContainers = Object.entries(core).filter(
    ([, v]: [string, unknown]) => {
      if (typeof v === "function") return false; // functions/classes are fine
      if (v instanceof Map || v instanceof Set || Array.isArray(v)) return true;
      if (v && typeof v === "object") return true; // unexpected mutable object
      return false;
    },
  );
  assert.deepEqual(
    sessionishContainers.map(([k]) => k),
    [],
    `core exports unexpected mutable module-level state: ${sessionishContainers
      .map(([k]) => k)
      .join(", ")}`,
  );
});
