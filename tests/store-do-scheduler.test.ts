// @irisrun/store-do DoScheduler certified against the shared scheduler conformance
// suite, PLUS the do-specific wiring the portable contract does not cover: the DO
// alarm (sleepUntil arms the EARLIEST due time across parked sessions), cold-isolate
// durability, and edgeHost's remote-only capability profile. The basic peek/confirm/
// signal assertions moved into the suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSchedulerConformance, register } from "@irisrun/store-conformance";
import { DoScheduler, edgeHost, DoStateStore } from "@irisrun/store-do";
import { FakeDoStorage } from "./lib/fake-do.ts";

// --- shared scheduler contract ----------------------------------------------
register(runSchedulerConformance(() => new DoScheduler(new FakeDoStorage())), test);

// --- do-specific: the DO alarm — earliest-due across parked sessions ---------

test("do alarm: sleepUntil sets the DO alarm to the EARLIEST due time across two parked sessions", async () => {
  const storage = new FakeDoStorage();
  const sched = new DoScheduler(storage);
  await sched.sleepUntil("s1", 100);
  assert.equal(await storage.getAlarm(), 100, "first sleepUntil arms the alarm at its wake time");
  await sched.sleepUntil("s2", 50);
  assert.equal(await storage.getAlarm(), 50, "an earlier park lowers the alarm");
  await sched.sleepUntil("s3", 200);
  assert.equal(await storage.getAlarm(), 50, "a later park leaves the earliest alarm intact");
});

// --- do-specific: cold-isolate durability -----------------------------------

test("do scheduler cold-isolate: a fresh DoScheduler over the same storage sees prior timers/signals", async () => {
  const storage = new FakeDoStorage();
  const a = new DoScheduler(storage);
  await a.sleepUntil("s", 10);
  await a.signal("s", "approve");
  const b = new DoScheduler(storage);
  assert.deepEqual(await b.dueWakeups(20), [
    { sessionId: "s", kind: "timer" },
    { sessionId: "s", kind: "signal", name: "approve" },
  ]);
  await b.confirmWoken("s", 20);
  const c = new DoScheduler(storage);
  assert.deepEqual(await c.dueWakeups(20), []);
});

// --- do-specific: edgeHost profile ------------------------------------------

test("do edgeHost: exposes the remote-only capability profile (name defaults to Cloudflare)", async () => {
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

test("do edgeHost: honors a custom name (the writer identity / refusal target label)", async () => {
  const host = edgeHost(new FakeDoStorage(), "EdgeCo");
  assert.equal(host.name, "EdgeCo");
  assert.equal(host.capabilities.tool_locality, "remote");
});
