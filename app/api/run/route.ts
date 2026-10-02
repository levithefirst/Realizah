import { NextResponse } from "next/server";
import { hasDatabase } from "@/lib/db";
import { parseComparisonInput } from "@/lib/comparison/input";
import { planComparison, runComparison } from "@/lib/comparison/service";
import { providerReadiness } from "@/lib/providers/readiness";
import { clientIp, hashIp, refundToken, takeToken } from "@/lib/ratelimit";
import { errorForLog } from "@/lib/redact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  if (!hasDatabase()) return NextResponse.json({ error: "Server is missing DATABASE_URL." }, { status: 503 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  const parsed = parseComparisonInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  let gate: Awaited<ReturnType<typeof takeToken>> | null = null;
  let ipHash = "";
  let refunded = false;
  // At most once per token taken, whatever path gets here.
  const refund = async () => {
    if (!gate?.allowed || refunded) return;
    refunded = true;
    const count = await refundToken(ipHash, gate.windowKey).catch(() => null);
    if (count !== null) gate = { ...gate, count };
  };

  try {
    // Only providers whose key is present and not rejected may run. The auth
    // probe is cached, so this is not a network call on every request.
    const { ready, statuses } = await providerReadiness({ verify: true });
    if (ready.size === 0) {
      return NextResponse.json(
        { error: "No model provider is available right now, so nothing was run. Your free comparison was not used.", providers: statuses },
        { status: 503 }
      );
    }
    // Plan first: unsupported tasks and empty candidate sets cost nothing and
    // do not use a free comparison.
    const { plan, selection, product } = await planComparison(parsed.input, { adapters: ready });
    if (!plan.executable || !selection) {
      return NextResponse.json({ error: plan.reason, unsupported: !plan.understanding.executable, plan }, { status: 422 });
    }
    ipHash = hashIp(clientIp(req.headers));
    gate = await takeToken(ipHash);
    if (!gate.allowed) {
      return NextResponse.json(
        { error: `Free limit reached: ${gate.limit} comparisons per day. Try again after ${gate.resetsAt.toUTCString()}.` },
        { status: 429 }
      );
    }
    const result = await runComparison(parsed.input, ipHash, selection, plan.understanding, product, ready);
    // Nothing came back for reasons outside the user's task: give it back.
    if (result.systemicFailure) await refund();
    return NextResponse.json({ ...result, quotaRefunded: refunded, remaining: Math.max(0, gate.limit - gate.count) });
  } catch (e) {
    // Our failure, not the user's: don't charge them a comparison for it.
    await refund();
    console.error("run failed", errorForLog(e));
    return NextResponse.json({ error: "The comparison failed on our side. Your free comparison was not used. Try again." }, { status: 500 });
  }
}
