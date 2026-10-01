import { NextResponse } from "next/server";
import { hasDatabase } from "@/lib/db";
import { parseComparisonInput } from "@/lib/comparison/input";
import { planComparison, runComparison } from "@/lib/comparison/service";
import { clientIp, hashIp, takeToken } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  if (!hasDatabase()) return NextResponse.json({ error: "Server is missing DATABASE_URL." }, { status: 503 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  const parsed = parseComparisonInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    // Plan first: unsupported tasks and empty candidate sets cost nothing and
    // do not use a free comparison.
    const { plan, selection, product } = await planComparison(parsed.input);
    if (!plan.executable || !selection) {
      return NextResponse.json({ error: plan.reason, unsupported: !plan.understanding.executable, plan }, { status: 422 });
    }
    const ipHash = hashIp(clientIp(req.headers));
    const gate = await takeToken(ipHash);
    if (!gate.allowed) {
      return NextResponse.json(
        { error: `Free limit reached: ${gate.limit} comparisons per day. Try again after ${gate.resetsAt.toUTCString()}.` },
        { status: 429 }
      );
    }
    const result = await runComparison(parsed.input, ipHash, selection, plan.understanding, product);
    return NextResponse.json({ ...result, remaining: Math.max(0, gate.limit - gate.count) });
  } catch (e) {
    console.error("run failed", e);
    return NextResponse.json({ error: "The comparison failed on our side. Try again." }, { status: 500 });
  }
}
