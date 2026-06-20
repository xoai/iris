// T3 — @irisrun/store-do DoScheduler + edgeHost. Mirrors the
// FsScheduler conformance (dueWakeups PEEKS at-least-once; confirmWoken consumes
// AFTER the resumed turn commits; durable across a cold isolate) AND adds the DO
// alarm wiring: sleepUntil sets the DO alarm to the EARLIEST due time across all
// parked sessions in this DO (so the isolate is durably woken at the right time).
// edgeHost exposes the remote-only capability profile + the wired ports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DoScheduler, edgeHost, DoStateStore } from "@irisrun/store-do";
import { FakeDoStorage } from "./lib/fake-do.ts";

test("T3-sched: a timer is not due before its wake time", async () => {
  const sched = new DoScheduler(new FakeDoStorage());
  await sched.sleepUntil("s", 10);
  assert.deepEqual(await sched.dueWakeups(5), []);
});

test("T3-sched: dueWakeups PEEKS (at-least-once) until confirmWoken consumes", async () => {
  const sched = new DoScheduler(new FakeDoStorage());
  await sched.sleepUntil("s", 10);
  assert.deepEqual(await sched.dueWakeups(20), [{ sessionId: "s", kind: "timer" }]);
  // re-peeking BEFORE confirm returns it AGAIN — at-least-once by design
  assert.deepEqual(await sched.dueWakeups(20), [{ sessionId: "s", kind: "timer" }]);
  await sched.confirmWoken("s", 20);
  assert.deepEqual(await sched.dueWakeups(20), []);
});

test("T3-sched: a signal round-trips (signal → waitForSignal no-op → peek → consume)", async () => {
  const sched = new DoScheduler(new FakeDoStorage());
  await sched.signal("s", "approve");
  await sched.waitForSignal("s", "approve"); // no-op: must not throw or drop the signal
  assert.deepEqual(await sched.dueWakeups(0), [
    { sessionId: "s", kind: "signal", name: "approve" },
  ]);
  await sched.confirmWoken("s", 0);
  assert.deepEqual(await sched.dueWakeups(0), []);
});

test("T3-sched: a signal carries its base64 payload through dueWakeups", async () => {
  const sched = new DoScheduler(new FakeDoStorage());
  await sched.signal("s", "approve", new TextEncoder().encode("yes"));
  const due = await sched.dueWakeups(0);
  assert.equal(due.length, 1);
  assert.equal(due[0].name, "approve");
});

// --- the DO alarm wiring: earliest-due across parked sessions ----------------

test("T3-alarm: sleepUntil sets the DO alarm to the EARLIEST due time across two parked sessions", async () => {
  const storage = new FakeDoStorage();
  const sched = new DoScheduler(storage);
  await sched.sleepUntil("s1", 100);
  assert.equal(await storage.getAlarm(), 100, "first sleepUntil arms the alarm at its wake time");
  // a SECOND, EARLIER park LOWERS the alarm (the earliest-due invariant)
  await sched.sleepUntil("s2", 50);
  assert.equal(await storage.getAlarm(), 50, "an earlier park lowers the alarm");
  // a LATER park does NOT raise the alarm past the earliest pending
  await sched.sleepUntil("s3", 200);
  assert.equal(await storage.getAlarm(), 50, "a later park leaves the earliest alarm intact");
});

// --- cold-isolate: a fresh DoScheduler over the same storage ----------------

test("T3-sched: state is DURABLE across a fresh isolate (a fresh DoScheduler sees prior timers/signals)", async () => {
  const storage = new FakeDoStorage();
  const a = new DoScheduler(storage);
  await a.sleepUntil("s", 10);
  await a.signal("s", "approve");
  // a brand-new isolate over the same storage — no shared memory
  const b = new DoScheduler(storage);
  assert.deepEqual(await b.dueWakeups(20), [
    { sessionId: "s", kind: "timer" },
    { sessionId: "s", kind: "signal", name: "approve" },
  ]);
  // confirming on a fresh isolate is also durable
  await b.confirmWoken("s", 20);
  const c = new DoScheduler(storage);
  assert.deepEqual(await c.dueWakeups(20), []);
});

// --- edgeHost profile + wired ports ------------------------------------------

test("T3-host: edgeHost exposes the remote-only capability profile (name defaults to Cloudflare)", async () => {
  const host = edgeHost(new FakeDoStorage());
  assert.equal(host.name, "Cloudflare");
  assert.deepEqual(host.capabilities, {
    long_running: false,
    filesystem: false,
    local_subprocess: false,
    websockets: false,
    tool_locality: "remote",
  });
  assert.ok(host.store instanceof DoStateStore, "store is a DoStateStore");
  assert.ok(host.scheduler instanceof DoScheduler, "scheduler is a DoScheduler");
});

test("T3-host: edgeHost honors a custom name (the writer identity / refusal target label)", async () => {
  const host = edgeHost(new FakeDoStorage(), "EdgeCo");
  assert.equal(host.name, "EdgeCo");
  assert.equal(host.capabilities.tool_locality, "remote");
});
