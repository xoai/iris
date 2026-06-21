// A fixture pluggable store module for the --store loader test: the third-party
// shape, exporting openStore({ url }) over the in-memory store. Loaded via
// `--store <file://…fixture-store.ts>` to prove a third-party store plugs in.
import { MemoryStateStore, MemoryScheduler } from "@irisrun/store-memory";

export function openStore(_opts: { url: string }): {
  store: MemoryStateStore;
  scheduler: MemoryScheduler;
  close(): void;
} {
  return { store: new MemoryStateStore(), scheduler: new MemoryScheduler(), close: () => {} };
}
