// The minimal `mysql2/promise` surface this adapter uses. `mysql2` is a PEER
// dependency — the operator installs it; Iris's tree never does. We import it via a
// NON-LITERAL specifier so `tsc` yields `any` (no module resolution, no `@types/mysql2`),
// and resolve the operator's installed `mysql2` at run time.
//
// mysql2 quirk: `query()` returns a two-tuple `[rowsOrHeader, fields]`. For SELECT the
// first element is a row array; for INSERT/UPDATE/DELETE it is a ResultSetHeader carrying
// `affectedRows`/`insertId`. Helpers below destructure each correctly.

/** A write result (INSERT/UPDATE/DELETE) — the first tuple element for non-SELECT. */
export interface MysqlResultHeader {
  affectedRows: number;
  insertId: number;
}

export interface MysqlConn {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface MysqlPool {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  getConnection(): Promise<MysqlConn>;
  end(): Promise<void>;
}

type CreatePool = (cfg: { uri: string }) => MysqlPool;

/** SELECT rows as record objects. */
export function rowsOf(result: [unknown, unknown]): Array<Record<string, unknown>> {
  return result[0] as Array<Record<string, unknown>>;
}

/** The write-result header (affectedRows/insertId). */
export function headerOf(result: [unknown, unknown]): MysqlResultHeader {
  return result[0] as MysqlResultHeader;
}

/** True for a unique/primary-key violation (mysql2 errno 1062 / code ER_DUP_ENTRY). */
export function isDuplicateKey(e: unknown): boolean {
  const err = e as { errno?: number; code?: string };
  return err?.errno === 1062 || err?.code === "ER_DUP_ENTRY";
}

export async function createPool(url: string): Promise<MysqlPool> {
  // `name` is annotated `string` (not the literal "mysql2/promise") so the import() below
  // is not statically resolved by tsc — it types as `any`, and resolves at run time.
  const name: string = "mysql2/promise";
  let mod: { createPool?: CreatePool; default?: { createPool?: CreatePool } };
  try {
    mod = (await import(name)) as { createPool?: CreatePool; default?: { createPool?: CreatePool } };
  } catch (e) {
    // The common case: the peer dep isn't installed. Translate Node's raw module-not-found
    // into a LOUD, actionable error naming the install command (the bare import error fires
    // BEFORE the export check below, so this catch is what makes the message friendly).
    const code = (e as { code?: string }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
      throw new Error("@irisrun/store-mysql: the `mysql2` peer dependency is not installed — run `npm i mysql2`");
    }
    throw e;
  }
  const create = mod.createPool ?? mod.default?.createPool;
  if (!create) {
    throw new Error("@irisrun/store-mysql: `mysql2` resolved but exposes no createPool — reinstall it (`npm i mysql2`)");
  }
  return create({ uri: url });
}
