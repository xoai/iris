// MANUAL smoke — NOT in the unit suite, NOT typechecked (repo-root manual/).
//   IRIS_WS_SMOKE=1 node manual/ws-channel-smoke.ts
//
// A WebSocket channel needs HELD connections → it requires the `websockets`
// capability (ADR-0008) and a real ws server (`ws`). This smoke FIRST enforces the
// capability gate (install-free, the no-silent-policy-widening floor): if the host
// adapter lacks `websockets`, it refuses LOUDLY before any transport work. Only a
// websockets-capable host proceeds to the (future) real `ws` server.
async function main() {
  if (process.env.IRIS_WS_SMOKE !== "1") {
    console.log("skip: set IRIS_WS_SMOKE=1 to run the WebSocket channel smoke (capability-gated; future — needs ws)");
    return;
  }
  // a serverless host does NOT hold connections → websockets capability absent
  const host = { name: "serverless", capabilities: { long_running: false, websockets: false } };
  if (host.capabilities.websockets !== true) {
    console.error(`ws-channel-smoke: host '${host.name}' lacks the 'websockets' capability (held connections) — REFUSING LOUDLY (ADR-0008). A WebSocket channel must not be silently downgraded onto a host that cannot hold connections. Provide a websockets-capable host to proceed.`);
    process.exit(1);
  }
  let ws;
  try {
    ws = await import("ws");
  } catch {
    console.error("ws-channel-smoke: 'ws' is not installed (future target). Refusing loudly rather than faking a pass.");
    process.exit(1);
  }
  console.log("ws-channel-smoke: capability satisfied + ws present (" + typeof ws + "). A real held-connection channel over runTurnOn is the future deliverable.");
}

main().catch((e) => { console.error("ws-channel-smoke FAIL: " + (e && e.message ? e.message : e)); process.exit(1); });
