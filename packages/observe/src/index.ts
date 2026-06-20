// @irisrun/observe — public surface (host; OTel-shaped spans + sink, journal-derived).
export const PACKAGE = "@irisrun/observe";

export { toSpans, collectingSink, consoleSink } from "./spans.ts";
export type { Span, Sink, SpanStatus } from "./spans.ts";
