import { NextResponse } from "next/server";
import { hasDatabase } from "@/lib/db";
import { listTools } from "@/lib/tools";
import { normalizeCriteria } from "@/lib/checks";
import { DEFAULT_TASK } from "@/lib/fixture";
import { clientIp, hashIp, takeToken } from "@/lib/ratelimit";
import { compare } from "@/lib/compare";
import { parseStatement } from "@/lib/parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: Request) {
  if (!hasDatabase()) return bad("Server is missing DATABASE_URL.", 503);
  if (!process.env.OPENAI_API_KEY) return bad("Server is missing OPENAI_API_KEY.", 503);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return bad("Request body must be JSON.");
  }

  const statement = String(body.statement ?? "").slice(0, 600).trim();
  const parsed = parseStatement(statement);
  const task = parsed.task || DEFAULT_TASK;
  const currentSlug = String(body.current ?? "");
  const altSlugs = Array.isArray(body.alternatives)
    ? body.alternatives.map(String)
    : [];
  const criteria = normalizeCriteria(body.criteria);

  const tools = await listTools();
  const bySlug = new Map(tools.map((t) => [t.slug, t]));
  const current = bySlug.get(currentSlug);
  if (!current) return bad("Pick your current tool from the list.");
  const alternatives = [...new Set(altSlugs)]
    .filter((s) => s !== currentSlug)
    .map((s) => bySlug.get(s))
    .filter((t): t is NonNullable<typeof t> => Boolean(t));
  if (alternatives.length < 1 || alternatives.length > 2) {
    return bad("Pick one or two alternatives that differ from your current tool.");
  }

  const ipHash = hashIp(clientIp(req.headers));
  const gate = await takeToken(ipHash);
  if (!gate.allowed) {
    return NextResponse.json(
      {
        error: `Free limit reached: ${gate.limit} comparisons per day. Try again after ${gate.resetsAt.toUTCString()}.`,
      },
      { status: 429 }
    );
  }

  try {
    const result = await compare({
      currentTool: parsed.tool || current.name,
      task,
      criteria,
      current,
      alternatives,
      fallback: bySlug.get("gpt-4o-mini"),
      ipHash,
    });
    return NextResponse.json({ ...result, remaining: Math.max(0, gate.limit - gate.count) });
  } catch (e) {
    console.error("run failed", e);
    return bad("The comparison failed on our side. Nothing was charged to you. Try again.", 500);
  }
}
