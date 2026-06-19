// @iris/demo — the no-model counter demo.
export const PACKAGE = "@iris/demo";
export {
  counterProgram,
  counterInitial,
  counterReducer,
  counterStep,
  TIMER_DELAY,
} from "./counter-program.ts";
export type { CounterState } from "./counter-program.ts";
export { makeDemoPerformers } from "./performers.ts";
