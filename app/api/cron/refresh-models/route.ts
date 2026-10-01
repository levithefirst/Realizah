import { NextResponse } from "next/server";
import { db, hasDatabase } from "@/lib/db";
import { refreshRegistry } from "@/lib/registry/refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Daily model-market refresh (Vercel Cron, see vercel.json). With CRON_SECRET
// set, only callers presenting it may run it. Without it, runs are throttled
// to one per hour so the endpoint can't be used to hammer the sources.
export async function GET(req: Request) {
  if (!hasDatabase()) return NextResponse.json({ error: "Server is missing DATABASE_URL." }, { status: 503 });
  const secret = process.env.CRON_SECRET;
  if (secret) {
    if (req.headers.get("authorization") !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  } else {
    const { rows } = await db().query<{ recent: boolean }>(
      `select exists (select 1 from registry_refreshes where started_at > now() - interval '1 hour') as recent`
    );
    if (rows[0].recent) {
      return NextResponse.json({ status: "skipped", reason: "A refresh ran within the last hour." });
    }
  }
  try {
    return NextResponse.json(await refreshRegistry());
  } catch (e) {
    console.error("refresh failed", e);
    return NextResponse.json({ error: "Refresh failed; the last snapshot is still in use." }, { status: 500 });
  }
}
