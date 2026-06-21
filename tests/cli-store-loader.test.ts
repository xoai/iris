// The pluggable --store loader (packages/cli/src/store.ts): built-in short names
// (sqlite|fs|memory) construct real stores; an arbitrary module specifier is loaded
// and its openStore({ url }) is used; bad modules fail loudly. Proves a third-party
// store plugs into the CLI without a fork.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { encode, acquireLease } from "@irisrun/core";
import type { StateStore } from "@irisrun/core";
import { resolveStore } from "../packages/cli/src/store.ts";

// A real store round-trip (lease → fenced append → dense readback) proves the
// resolved store actually works, not just that it constructed.
async function roundTrip(store: StateStore): Promise<void> {
  const l = await acquireLease(store, "s", "H");
  assert.ok(l.ok, "lease acquires");
  const fence = l.ok ? l.fence : 0;
  assert.deepEqual(await store.append("s", 0, [encode({ n: 1 })], fence), { ok: true, seq: 0 });
  assert.equal((await store.readJournal("s", 0)).length, 1);
}

test("resolveStore: default (no --store) is sqlite and works", async () => {
  const { store, close } = await resolveStore(undefined, ":memory:");
  await roundTrip(store);
  await close();
});

test("resolveStore: --store memory works, and its scheduler peeks/confirms", async () => {
  const { store, scheduler, close } = await resolveStore("memory", ":memory:");
  await roundTrip(store);
  await scheduler.sleepUntil("s", 10);
  assert.deepEqual(await scheduler.dueWakeups(20), [{ sessionId: "s", kind: "timer" }]);
  await scheduler.confirmWoken("s", 20);
  assert.deepEqual(await scheduler.dueWakeups(20), []);
  await close();
});

test("resolveStore: --store fs works over a temp root", async () => {
  const root = mkdtempSync(join(tmpdir(), "iris-store-loader-"));
  const { store, close } = await resolveStore("fs", root);
  await roundTrip(store);
  await close();
});

test("resolveStore: a --store <module> exporting openStore is loaded and used", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const spec = pathToFileURL(join(here, "lib", "fixture-store.ts")).href;
  const { store, scheduler } = await resolveStore(spec, "ignored://url");
  await roundTrip(store);
  assert.equal(typeof scheduler.dueWakeups, "function", "the third-party scheduler implements the wakeup source");
});

test("resolveStore: a module without openStore fails loudly", async () => {
  await assert.rejects(resolveStore("@irisrun/core", ":memory:"), /must export openStore/);
});

test("resolveStore: an unresolvable module fails loudly", async () => {
  await assert.rejects(resolveStore("@irisrun/store-does-not-exist-xyz", ":memory:"), /could not import/);
});

test("resolveStore: --store memory with a real db path warns (ephemeral)", async () => {
  const orig = console.warn;
  let warned = "";
  console.warn = (m: string) => {
    warned += m;
  };
  try {
    await (await resolveStore("memory", "/tmp/some.sqlite")).close();
  } finally {
    console.warn = orig;
  }
  assert.match(warned, /ignores --db/);
});
