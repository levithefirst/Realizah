// In-process PostgreSQL 18 (PGlite) with all migrations applied, exposed
// through the same query() shape lib/db.ts uses.
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readdir, readFile } from "node:fs/promises";
import { setTestDb } from "../lib/db";

export async function freshDb() {
  const pg = new PGlite({ extensions: { pgcrypto } });
  const dir = new URL("../db/migrations/", import.meta.url);
  for (const f of (await readdir(dir)).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(await readFile(new URL(f, dir), "utf8"));
  }
  const pool = {
    async query(text: string, params?: unknown[]) {
      if (!params?.length && text.includes(";")) {
        await pg.exec(text);
        return { rows: [], rowCount: 0 };
      }
      const r = await pg.query(text, params as any[]);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
  };
  setTestDb(pool);
  return pg;
}
