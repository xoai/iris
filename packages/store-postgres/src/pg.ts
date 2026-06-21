// The minimal `pg` (node-postgres) surface this adapter uses. `pg` is a PEER
// dependency — the operator installs it; Iris's tree never does. We import it via a
// NON-LITERAL specifier so `tsc` yields `any` (no module resolution, no `@types/pg`),
// and resolve the operator's installed `pg` at run time.
export interface PgResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
}

export interface PgClient {
  query(text: string, params?: unknown[]): Promise<PgResult>;
  release(): void;
}

export interface PgPool {
  query(text: string, params?: unknown[]): Promise<PgResult>;
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

type PoolCtor = new (cfg: { connectionString: string }) => PgPool;

export async function createPool(url: string): Promise<PgPool> {
  // `name` is annotated `string` (not the literal "pg") so the import() below is not
  // statically resolved by tsc — it types as `any`, and resolves `pg` at run time.
  const name: string = "pg";
  const mod = (await import(name)) as { Pool?: PoolCtor; default?: { Pool?: PoolCtor } };
  const Pool = mod.Pool ?? mod.default?.Pool;
  if (!Pool) {
    throw new Error(
      "@irisrun/store-postgres: the `pg` peer dependency is not installed — run `npm i pg`",
    );
  }
  return new Pool({ connectionString: url });
}
