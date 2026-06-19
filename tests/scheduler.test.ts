import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, SqliteScheduler } from "@iris/store-sqlite";

test("scheduler: timer is not due before its wake time", async () => {
  const sched = new SqliteScheduler(openDatabase(":memory:"));
  await sched.sleepUntil("s", 10);
  assert.deepEqual(sched.dueWakeups(5), []);
});

test("scheduler: dueWakeups PEEKS (does not consume) until confirmWoken", async () => {
  const sched = new SqliteScheduler(openDatabase(":memory:"));
  await sched.sleepUntil("s", 10);

  // due at now=20; peeking repeatedly keeps returning it (at-least-once)
  assert.deepEqual(sched.dueWakeups(20), [{ sessionId: "s", kind: "timer" }]);
  assert.deepEqual(sched.dueWakeups(20), [{ sessionId: "s", kind: "timer" }]);

  // confirm consumes it (turn committed) → no longer due
  sched.confirmWoken("s", 20);
  assert.deepEqual(sched.dueWakeups(20), []);
});

test("scheduler: a signal is peeked then consumed by confirmWoken", async () => {
  const sched = new SqliteScheduler(openDatabase(":memory:"));
  await sched.signal("s", "approve");
  assert.deepEqual(sched.dueWakeups(0), [
    { sessionId: "s", kind: "signal", name: "approve" },
  ]);
  sched.confirmWoken("s", 0);
  assert.deepEqual(sched.dueWakeups(0), []);
});
