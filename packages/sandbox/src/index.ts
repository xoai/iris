// @iris/sandbox — public surface (host-side; zero external deps).
export const PACKAGE = "@iris/sandbox";

export { makeCredentialBroker, networkAllows } from "./backend.ts";
export type {
  NetworkPolicy,
  RunResult,
  SandboxSession,
  SandboxBackend,
  CreateOptions,
  OutboundRequest,
  CredentialBroker,
} from "./backend.ts";

export { createInMemorySession, inMemoryBackend } from "./inmemory.ts";
export type { InMemorySession } from "./inmemory.ts";

export { dockerBackend, createDockerSession } from "./docker.ts";
export type { DockerCreateOptions } from "./docker.ts";
