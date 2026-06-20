// Demo runner / CLI. Drives the counter program against the real
// SQLite store + scheduler. Designed so a turn runs in its OWN process and
// exits, so park/resume can be exercised across a true process restart.
//
//   node run.ts --session <id> --db <path>                 # run a turn, park or finish, exit
//   node run.ts --session <id> --db <path> --resume --now <t>   # rehydrate from disk, continue
//
// Prints a single JSON line to stdout: { status, output?, wait? }.
import { runTurn } from "@irisrun/core";
import type { LogicalClock } from "@irisrun/core";
import {
  openDatabase,
  SqliteStateStore,
  SqliteScheduler,
} from "@irisrun/store-sqlite";
import { counterProgram } from "./counter-program.ts";
import { makeDemoPerformers } from "./performers.ts";

class RunnerClock implements LogicalClock {
  private t: number;
  constructor(t: number) {
    this.t = t;
  }
  now(): number {
    return this.t;
  }
}

interface Args {
  session: string;
  db: string;
  resume: boolean;
  now: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const session = get("--session");
  const db = get("--db");
  if (!session) throw new Error("missing --session <id>");
  if (!db) throw new Error("missing --db <path>");
  return {
    session,
    db,
    resume: argv.includes("--resume"),
    now: Number(get("--now") ?? "0"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = openDatabase(args.db);
  const store = new SqliteStateStore(db);
  // try/finally so the db handle is closed on EVERY exit path, including a thrown
  // error — not just the happy paths.
  try {
    const scheduler = new SqliteScheduler(db);
    const clock = new RunnerClock(args.now);

    // On resume, PEEK whether the durable timer is due at this logical time. We
    // confirm (consume) the wakeup only AFTER the turn commits, so a crash or
    // abort re-fires rather than orphaning the session (at-least-once wakeup).
    if (args.resume) {
      const due = scheduler.dueWakeups(args.now);
      if (!due.some((w) => w.sessionId === args.session)) {
        process.stdout.write(
          JSON.stringify({ status: "not_due", now: args.now }) + "\n",
        );
        return;
      }
    }

    const out = await runTurn(
      {
        store,
        scheduler,
        clock,
        program: counterProgram,
        performers: makeDemoPerformers(clock),
        defDigest: "sha256:demo-counter-v1",
        holderId: `pid-${process.pid}`,
        assertReplay: process.env.IRIS_ASSERT !== "0",
      },
      args.session,
    );

    // The turn committed (finished or re-parked, not aborted) → consume the wakeup.
    if (args.resume && out.status !== "aborted") {
      scheduler.confirmWoken(args.session, args.now);
    }

    const line =
      out.status === "finished"
        ? { status: out.status, output: out.output }
        : out.status === "parked"
          ? { status: out.status, wait: out.wait }
          : { status: out.status };
    process.stdout.write(JSON.stringify(line) + "\n");
  } finally {
    store.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[iris-demo] error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
});
