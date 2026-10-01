import { Pool } from "pg";

function withSsl(url: string): string {
  if (/[?&]sslmode=/.test(url)) return url;
  return url + (url.includes("?") ? "&" : "?") + "sslmode=require";
}

declare global {
  // eslint-disable-next-line no-var
  var __realizahPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __realizahTestDb: Pool | undefined;
}

// Tests swap in an in-process Postgres (PGlite) through this hook.
export function setTestDb(pool: unknown): void {
  global.__realizahTestDb = pool as Pool | undefined;
}

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function db(): Pool {
  if (global.__realizahTestDb) return global.__realizahTestDb;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!global.__realizahPool) {
    global.__realizahPool = new Pool({
      connectionString: withSsl(url),
      max: Number(process.env.DB_POOL_MAX) || 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return global.__realizahPool;
}
