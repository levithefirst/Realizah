import { NextResponse } from "next/server";
import { hasDatabase } from "@/lib/db";
import { listTools } from "@/lib/tools";
import { listAiTools } from "@/lib/aiTools";
import { checkSupport } from "@/lib/support";
import { normalizeCriteria } from "@/lib/checks";
import { clientIp, hashIp, takeToken } from "@/lib/ratelimit";
import { compare } from "@/lib/compare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_TASK_CHARS = 600;

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

  const toolName = String(body.tool ?? "").slice(0, 80).trim();
  const useCase = String(body.useCase ?? "").slice(0, 200).trim();
  // Sent to every model exactly as typed. Empty means the demo fixture run;
  // a typed task is never trimmed, truncated or replaced.
  const task = typeof body.task === "string" ? body.task : "";
  const modelSlugs = Array.isArray(body.models) ? [...new Set(body.models.map(String))] : [];
  const criteria = normalizeCriteria(body.criteria);
  if (!toolName) return bad("Tell us which AI tool you use now.");
  if (!useCase) return bad("Tell us what you use it for.");
  if (task.length > MAX_TASK_CHARS) return bad(`Task is too long. Keep it under ${MAX_TASK_CHARS} characters.`);

  // Decide support before spending a free run or any model call.
  const registry = await listAiTools();
  const support = checkSupport({ tool: toolName, useCase, task }, registry);
  if (!support.supported) {
    return NextResponse.json({ error: support.message, unsupported: true }, { status: 422 });
  }

  const tools = await listTools();
  const bySlug = new Map(tools.map((t) => [t.slug, t]));
  const models = modelSlugs
    .map((s) => bySlug.get(s))
    .filter((t): t is NonNullable<typeof t> => Boolean(t));
  if (models.length < 2 || models.length > 3) {
    return bad("Pick two or three models to run the task on.");
  }
  // A verified mapping is the only way the user's tool gets its own card.
  const verifiedModelSlug = support.tool?.verifiedModelSlug ?? null;
  const verifiedModel = verifiedModelSlug ? bySlug.get(verifiedModelSlug) : undefined;
  if (verifiedModel && !models.some((m) => m.slug === verifiedModel.slug)) models.push(verifiedModel);

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
      toolName: support.tool?.name ?? toolName,
      useCase,
      task,
      criteria,
      models,
      verifiedModelSlug: verifiedModel ? verifiedModel.slug : null,
      fallback: bySlug.get("gpt-4o-mini"),
      ipHash,
    });
    return NextResponse.json({ ...result, remaining: Math.max(0, gate.limit - gate.count) });
  } catch (e) {
    console.error("run failed", e);
    return bad("The comparison failed on our side. Nothing was charged to you. Try again.", 500);
  }
}
