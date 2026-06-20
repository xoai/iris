# Tests

Three folders, three jobs. A file's folder tells you what it is.

```text
tests/
├── *.test.ts     # the suite — runs on `npm test`, the source of truth
├── lib/          # shared harness: fakes + conformance suites the suite is built on
├── examples/     # runnable, test-verified reference implementations (bridges, demos)
└── smoke/        # real-egress / real-infra checks — gated, NOT in `npm test`
```

## The headline: `npm test` needs nothing

```sh
npm test        # the whole suite — green with NO API key and NO infrastructure
```

The suite is install-free and deterministic. It never calls a real model, registry,
or host: `lib/` supplies fakes (`fake-model`, `fake-tool`, `fake-do`, …) and the
optional live tier (`lib/live-gate.ts`) **skips cleanly** unless you opt in. So a
contributor can verify Iris end-to-end on a fresh clone with zero setup. That zero-setup
path is the point — keep it that way.

Opt into the live model-conformance tier only when you want it:

```sh
IRIS_LIVE_CONFORMANCE=1 ANTHROPIC_API_KEY=… npm test   # adds the live-provider tier; off → skipped
```

## `lib/` — the shared harness

The backbone of the suite, and the **executable spec** for Iris's port contracts —
production code points here (e.g. a provider must pass `lib/model-provider-conformance.ts`;
a channel must pass `lib/channel-port-conformance.ts`). Fakes, fixtures, the chaos
helpers, and `live-gate` live here. Imported by the suite; never published.

## `examples/` — reference implementations (and they're tested)

Runnable, copy-able reference code, each one regression-locked by a `*.test.ts`:

| File | What it shows | Run |
| --- | --- | --- |
| `portability-demo.ts` | the cross-host resume proof | `node tests/examples/portability-demo.ts` |
| `cross-host-journal-demo.ts` | a session migrating fs → sqlite → edge | `npm run demo:cross-host` |
| `webhook-bridge.ts` | a generic bridge over the wire protocol (zero `@irisrun/*` imports) | `npm run demo:bridge` |
| `bridge-reference.ts` | a two-turn conversation through that bridge | `npm run demo:bridge` |
| `platform-bridge.ts` + `bridges/` | Discord / Telegram / Teams as bridges (not packages) | see `docs/reference/bridge-pattern.md` |

## `smoke/` — real egress, gated, outside the suite

These hit real infrastructure (Docker, a registry, an edge host, an OTLP collector)
or a real provider, so they're **excluded from `npm test`** and each runs only when its
flag is set — otherwise they refuse loudly rather than fake a pass.

| Smoke | Needs | Run |
| --- | --- | --- |
| `docker-smoke.ts` | Docker CLI | `IRIS_DOCKER_SMOKE=1 node tests/smoke/docker-smoke.ts` |
| `oci-registry-smoke.ts` | an OCI registry | `node tests/smoke/oci-registry-smoke.ts` |
| `cloudflare-workers-smoke.ts` | workerd / wrangler | `IRIS_EDGE_SMOKE=1 node tests/smoke/cloudflare-workers-smoke.ts` |
| `serverless-deploy-smoke.ts` | Cloudflare DO / Lambda | `IRIS_SERVERLESS_SMOKE=1 node tests/smoke/serverless-deploy-smoke.ts` |
| `iris-deploy-smoke.ts` | edge host **+ a model API key** | `IRIS_DEPLOY_SMOKE=1 node tests/smoke/iris-deploy-smoke.ts` |
| `otlp-export-smoke.ts` | an OTLP collector (`:4318`) | `IRIS_OTLP_SMOKE=1 node tests/smoke/otlp-export-smoke.ts` |
| `grpc-channel-smoke.ts` | `@grpc/grpc-js` | `IRIS_GRPC_SMOKE=1 node tests/smoke/grpc-channel-smoke.ts` |
| `rest-smoke.ts` | a real HTTP socket | `IRIS_REST_SMOKE=1 node tests/smoke/rest-smoke.ts` |
| `serve-streaming-smoke.ts` | real serve (REST + SSE + WS) **+ a model API key** | `IRIS_SERVE_SMOKE=1 node tests/smoke/serve-streaming-smoke.ts` |
| `web-channel-smoke.ts` | the web channel | `IRIS_WEB_SMOKE=1 node tests/smoke/web-channel-smoke.ts` |
| `mcp-server-smoke.ts` | stdio (install-free) | `IRIS_MCP_SERVER_SMOKE=1 node tests/smoke/mcp-server-smoke.ts` |
| `mcp-smoke.ts` | an MCP tool over stdio | `IRIS_MCP_TOOL=echo IRIS_MCP_INPUT='{"message":"hi"}' node tests/smoke/mcp-smoke.ts` |
| `npm-pack-smoke.ts` | the npm pack/init flow | `IRIS_PACK_SMOKE=1 node tests/smoke/npm-pack-smoke.ts` |
