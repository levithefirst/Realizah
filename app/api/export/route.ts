import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { hasDatabase } from "@/lib/db";
import { exportRuns, parseExportQuery } from "@/lib/comparison/export";
import { readCredential } from "@/lib/providers/credentials";
import { errorForLog } from "@/lib/redact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Operator-only: the export contains people's task text and model replies.
// Disabled unless EXPORT_TOKEN is set; send it as "Authorization: Bearer <token>".
function authorized(req: Request, token: string): boolean {
  const given = (req.headers.get("authorization") ?? "").replace(/^bearer\s+/i, "").trim();
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(token).digest();
  return given.length > 0 && timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  const token = readCredential(process.env.EXPORT_TOKEN).key;
  if (!token) return NextResponse.json({ error: "Export is disabled on this server." }, { status: 404 });
  if (!authorized(req, token)) return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: { "www-authenticate": "Bearer" } });
  if (!hasDatabase()) return NextResponse.json({ error: "Server is missing DATABASE_URL." }, { status: 503 });
  const parsed = parseExportQuery(new URL(req.url).searchParams);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    return NextResponse.json(await exportRuns(parsed.query), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error("export failed", errorForLog(e));
    return NextResponse.json({ error: "Export failed." }, { status: 500 });
  }
}
