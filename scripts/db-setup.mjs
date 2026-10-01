// Applies db/migrations/*.sql in name order, once each, recording what ran.
// Usage: node --env-file=.env scripts/db-setup.mjs
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

const raw = process.env.DATABASE_URL;
if (!raw) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const url = /sslmode=/.test(raw) ? raw : raw + (raw.includes("?") ? "&" : "?") + "sslmode=require";
const dir = new URL("../db/migrations/", import.meta.url);

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await client.query(`select name from schema_migrations`)).rows.map((r) => r.name));
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const sql = await readFile(new URL(file, dir), "utf8");
    await client.query("begin");
    await client.query(sql);
    await client.query(`insert into schema_migrations (name) values ($1)`, [file]);
    await client.query("commit");
    console.log(`applied ${file}`);
  }
} catch (e) {
  await client.query("rollback").catch(() => {});
  throw e;
} finally {
  await client.end();
}
