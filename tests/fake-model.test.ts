import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "@irisrun/core";
import type { ModelCallResult } from "@irisrun/provider-anthropic";
import { makeFakeModel, type CallCounter } from "./lib/fake-model.ts";

test("fake-model: deterministic, request-derived reply; counts calls", async () => {
  const counter: CallCounter = { n: 0 };
  const perf = makeFakeModel(counter);
  const request: Json = {
    model: "fake",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "..." },
      { role: "user", content: "again" },
    ],
  };
  const out = await perf(request);
  assert.ok(out.ok);
  if (out.ok) {
    const r = out.value as unknown as ModelCallResult;
    assert.equal(r.role, "assistant");
    assert.equal(r.content, "echo:again"); // last user message
    assert.equal(r.stopReason, "end_turn");
  }
  // deterministic + counted
  const out2 = await perf(request);
  assert.deepEqual(out2, out);
  assert.equal(counter.n, 2);
});
