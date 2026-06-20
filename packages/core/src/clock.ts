// Logical clock port. The core never reads a wall clock; time is a
// monotonic integer supplied by the runner and recorded via a `clock` effect.
import type { LogicalTime } from "./journal.ts";

export interface LogicalClock {
  now(): LogicalTime;
}
