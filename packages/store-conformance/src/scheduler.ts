// The Scheduler conformance cases — the durable-timer + signal substrate and the
// host-side peek→confirm wakeup protocol (at-least-once). dueWakeups/confirmWoken
// may be sync or async; the cases `await` them so both work.
import assert from "node:assert/strict";
import type { ConformanceCase, SchedulerFactory } from "./types.ts";

export function runSchedulerConformance(make: SchedulerFactory): ConformanceCase[] {
  const cases: ConformanceCase[] = [];
  const c = (name: string, fn: () => Promise<void>): void => {
    cases.push({ name: `scheduler: ${name}`, fn });
  };

  c("a timer is not due before its wake time", async () => {
    const sched = await make();
    await sched.sleepUntil("s", 10);
    assert.deepEqual(await sched.dueWakeups(5), []);
  });

  c("dueWakeups PEEKS (at-least-once) until confirmWoken consumes", async () => {
    const sched = await make();
    await sched.sleepUntil("s", 10);
    assert.deepEqual(await sched.dueWakeups(20), [{ sessionId: "s", kind: "timer" }]);
    // re-peeking BEFORE confirm returns it AGAIN — at-least-once by design
    assert.deepEqual(await sched.dueWakeups(20), [{ sessionId: "s", kind: "timer" }]);
    await sched.confirmWoken("s", 20);
    assert.deepEqual(await sched.dueWakeups(20), []);
  });

  c("a signal round-trips (signal → waitForSignal no-op → peek → consume)", async () => {
    const sched = await make();
    await sched.signal("s", "approve");
    await sched.waitForSignal("s", "approve"); // no-op: must not throw or drop the signal
    assert.deepEqual(await sched.dueWakeups(0), [{ sessionId: "s", kind: "signal", name: "approve" }]);
    await sched.confirmWoken("s", 0);
    assert.deepEqual(await sched.dueWakeups(0), []);
  });

  c("a signal carries its name through dueWakeups (payload-bearing)", async () => {
    const sched = await make();
    await sched.signal("s", "approve", new TextEncoder().encode("yes"));
    const due = await sched.dueWakeups(0);
    assert.equal(due.length, 1);
    assert.equal(due[0].kind, "signal");
    assert.equal(due[0].name, "approve");
  });

  // --- G4 multiple signals ---------------------------------------------------

  c("multiple signals to one session are all delivered, then consumed together", async () => {
    const sched = await make();
    await sched.signal("s", "a");
    await sched.signal("s", "b");
    const names = (await sched.dueWakeups(0))
      .filter((w) => w.kind === "signal")
      .map((w) => w.name)
      .sort();
    assert.deepEqual(names, ["a", "b"]);
    await sched.confirmWoken("s", 0);
    assert.deepEqual(await sched.dueWakeups(0), []);
  });

  // --- G5 orphaned wait ------------------------------------------------------

  c("a waitForSignal with no matching signal is NOT a wakeup", async () => {
    const sched = await make();
    await sched.waitForSignal("s", "approve");
    assert.deepEqual(await sched.dueWakeups(0), []); // a wait alone never wakes
  });

  return cases;
}
