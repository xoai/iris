// @irisrun/audit — the audit & reproducible-eval product surface.
// Pure read-only projections over the existing journal; zero kernel change.
export const PACKAGE = "@irisrun/audit";

export { auditSession, renderAudit } from "./audit.ts";
export type { AuditEntry, SessionAudit } from "./audit.ts";

export { verifyReplay, verifySession, verifyStructure } from "./verify.ts";
export type { VerifyResult } from "./verify.ts";

export { fnv1a32hex } from "./fnv.ts";
