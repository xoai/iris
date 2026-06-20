// @irisrun/sandbox — public surface (host-side; zero external deps).
export const PACKAGE = "@irisrun/sandbox";

export { makeCredentialBroker, networkAllows, normalizeHost } from "./backend.ts";
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

export { startEgressProxy, SECRET_HEADER } from "./egress-proxy.ts";
export type { EgressProxyOptions, EgressProxyHandle } from "./egress-proxy.ts";
