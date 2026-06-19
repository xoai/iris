// @iris/store-do — the Cloudflare/edge (Durable Objects) host adapter surface.
// store-fs invariants (CAS/fencing/dense-append/hwm/snapshot) over a narrow
// DoStorage abstraction, plus a Scheduler whose durable timer is the DO alarm.
// Install-free: tested against FakeDoStorage; the real isolate is a manual smoke.
export const PACKAGE = "@iris/store-do";

export type { DoStorage } from "./do-storage.ts";
export { DoStateStore } from "./store.ts";
export { DoScheduler } from "./scheduler.ts";
export type { Wakeup } from "./scheduler.ts";
export { edgeHost } from "./host.ts";
export type { EdgeHostAdapter } from "./host.ts";
