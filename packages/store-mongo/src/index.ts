// @irisrun/store-mongo — a host store on MongoDB, plugged into the CLI via
// `--store @irisrun/store-mongo --db mongodb://…`. `mongodb` is a peer dependency.
import { connect } from "./mongo.ts";
import { MongoStateStore } from "./store.ts";
import { MongoScheduler } from "./scheduler.ts";

export const PACKAGE = "@irisrun/store-mongo";
export { MongoStateStore } from "./store.ts";
export { MongoScheduler } from "./scheduler.ts";
export { connect, isDuplicateKey, dbNameFromUrl } from "./mongo.ts";
export type { MongoLike, MongoColl, MongoCursor } from "./mongo.ts";

/** The CLI `--store` entry point: connect, return the ports. Collections are created on
 *  demand by Mongo, so there is no bootstrap DDL. */
export async function openStore({ url }: { url: string }): Promise<{
  store: MongoStateStore;
  scheduler: MongoScheduler;
  close(): Promise<void>;
}> {
  const { db, close } = await connect(url);
  return {
    store: new MongoStateStore(db),
    scheduler: new MongoScheduler(db),
    close,
  };
}
