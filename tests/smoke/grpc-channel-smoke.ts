// MANUAL smoke — NOT in the unit suite, NOT typechecked (tests/smoke/).
//   IRIS_GRPC_SMOKE=1 node tests/smoke/grpc-channel-smoke.ts
//
// A gRPC server-streaming channel (the natural fit for token/event
// streaming) is a REAL external target needing @grpc/grpc-js — kept OUT of the
// install-free suite (per the zero-runtime-dependency invariant). The in-suite
// reachability proofs are REST + the MCP-server channel. When enabled,
// this attempts to load @grpc/grpc-js and refuses LOUDLY with install guidance if
// absent (it is a future target, like the CF/Lambda smokes).
async function main() {
  if (process.env.IRIS_GRPC_SMOKE !== "1") {
    console.log("skip: set IRIS_GRPC_SMOKE=1 to run the gRPC channel smoke (future — needs @grpc/grpc-js)");
    return;
  }
  let grpc;
  try {
    grpc = await import("@grpc/grpc-js");
  } catch {
    console.error("grpc-channel-smoke: @grpc/grpc-js is not installed. This is a FUTURE target — install it to run a real gRPC server-streaming channel that wraps runTurnOn with the two-identifier protocol. Refusing loudly rather than faking a pass.");
    process.exit(1);
  }
  console.log("grpc-channel-smoke: @grpc/grpc-js present (" + typeof grpc + "). A real server-streaming channel over runTurnOn is the future deliverable here.");
}

main().catch((e) => { console.error("grpc-channel-smoke FAIL: " + (e && e.message ? e.message : e)); process.exit(1); });
