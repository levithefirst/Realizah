// Applies db/schema.sql then db/seed.sql to DATABASE_URL.
// Usage: node --env-file=.env scripts/db-setup.mjs
import { readFile } from "node:fs/promises";
import pg from "pg";

const raw = process.env.DATABASE_URL;
if (!raw) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const url = /sslmode=/.test(raw) ? raw : raw + (raw.includes("?") ? "&" : "?") + "sslmode=require";

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  for (const file of ["db/schema.sql", "db/seed.sql"]) {
    const sql = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    await client.query(sql);
    console.log(`applied ${file}`);
  }
} finally {
  await client.end();
}
