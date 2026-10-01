import { NextResponse } from "next/server";
import { hasDatabase } from "@/lib/db";
import { parseComparisonInput } from "@/lib/comparison/input";
import { planComparison } from "@/lib/comparison/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Dry run: task understanding and candidate selection. No model is called
// and nothing is spent, so it is also available as GET for inspection.
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  return plan({ tool: q.get("tool"), useCase: q.get("useCase"), task: q.get("task"), budgetUsd: q.get("budgetUsd"), wordMax: q.get("wordMax") });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  return plan(body);
}

async function plan(body: Record<string, unknown>) {
  if (!hasDatabase()) return NextResponse.json({ error: "Server is missing DATABASE_URL." }, { status: 503 });
  const parsed = parseComparisonInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    const { plan } = await planComparison(parsed.input);
    return NextResponse.json(plan);
  } catch (e) {
    console.error("plan failed", e);
    return NextResponse.json({ error: "Could not plan this comparison. Try again." }, { status: 500 });
  }
}
