# @irisrun/provider-conformance

The importable certification suite for the Iris **model port**. A `model_call` performer
(buffered + streaming) that passes it is a first-class Iris provider — the same suite the
first-party `@irisrun/provider-anthropic` and `@irisrun/provider-openai` adapters pass.

Runner-agnostic: `runModelProviderConformance(fixture)` returns a list of cases; `register`
wires them into `node:test` (or any `(name, fn)` runner), so it runs in your own CI without
this package depending on a test runner.

```ts
import { test } from "node:test";
import { runModelProviderConformance, register } from "@irisrun/provider-conformance";
import type { ConformanceFixture } from "@irisrun/provider-conformance";
import { myModelPerformer, myStreamingModelPerformer } from "./index.ts";

const fixture: ConformanceFixture = {
  name: "my-provider",
  envKey: "MY_API_KEY",
  makeBuffered: (opts) => myModelPerformer(opts),
  makeStreaming: (opts) => myStreamingModelPerformer(opts),
  // ...representative wire bodies + request-shape assertions
};

register(runModelProviderConformance(fixture), test);
```

This package is also the **canonical home** for the model-port wire types
(`ModelCallRequest`, `ModelCallResult`, `ModelMessage`) and the provider-factory option
shapes (`ModelPerformerOptions`, `StreamingModelPerformerOptions`). See
[Adding a provider](../../docs/contributing/adding-a-provider.md).
