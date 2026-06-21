// @irisrun/provider-conformance — the importable certification suite for the Iris
// model port. A model_call performer (buffered + streaming) that passes it is a
// first-class Iris provider. Also the canonical home for the model-port wire types.
export const PACKAGE = "@irisrun/provider-conformance";
export { runModelProviderConformance } from "./suite.ts";
export { register } from "./register.ts";
export type {
  ConformanceCase,
  ConformanceFixture,
  Captured,
  ModelMessage,
  ModelCallRequest,
  ModelCallResult,
  ModelPerformerOptions,
  StreamingModelPerformerOptions,
} from "./types.ts";
