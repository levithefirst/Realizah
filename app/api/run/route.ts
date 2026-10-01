import { NextResponse } from "next/server";
import { hasDatabase } from "@/lib/db";
import { listTools } from "@/lib/tools";
import { listAiTools } from "@/lib/aiTools";
import { checkSupport } from "@/lib/support";
import { normalizeCriteria } from "@/lib/checks";
import { clientIp, hashIp, takeToken } from "@/lib/ratelimit";
import { compare } from "@/lib/compare";
import { selectModels, MIN_MODELS } from "@/lib/selectModels";
import { DEFAULT_WORD_CAP, MAX_WORD_CAP, MIN_WORD_CAP, detectWordLimit, parseWordCap } from "@/lib/wordLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_TASK_CHARS = 600;

function configuredProviders(): Set<string> {
  const providers = new Set<string>();
  if (process.env.OPENAI_API_KEY) providers.add("openai");
  return providers;
}

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
  // Word cap: the user's explicit value, else the limit the task states, else 80.
  const rawCap = (body.criteria as Record<string, unknown> | undefined)?.wordCap;
  const userCap = rawCap === undefined || rawCap === null || rawCap === "" ? null : parseWordCap(rawCap as string | number);
  if (rawCap !== undefined && rawCap !== null && rawCap !== "" && userCap === null) {
    return bad(`Word limit must be a whole number from ${MIN_WORD_CAP} to ${MAX_WORD_CAP}.`);
  }
  const criteria = normalizeCriteria({
    ...(body.criteria as object),
    wordCap: userCap ?? detectWordLimit(task) ?? DEFAULT_WORD_CAP,
  });
  if (!toolName) return bad("Tell us which AI tool you use now.");
  if (!useCase) return bad("Tell us what you use it for.");
  if (task.length > MAX_TASK_CHARS) return bad(`Task is too long. Keep it under ${MAX_TASK_CHARS} characters.`);

  // Decide support before spending a free run or any model call.
  const registry = await listAiTools();
  const support = checkSupport({ tool: toolName, useCase, task }, registry);
  if (!support.supported) {
    return NextResponse.json({ error: support.message, unsupported: true }, { status: 422 });
  }

  // Models are chosen here, never by the browser: every enabled model whose
  // provider we hold a key for. A verified mapping is the only way the
  // user's tool gets its own card.
  const tools = await listTools();
  const bySlug = new Map(tools.map((t) => [t.slug, t]));
  const verifiedModelSlug = support.tool?.verifiedModelSlug ?? null;
  const models = selectModels(tools, {
    providers: configuredProviders(),
    max: Number(process.env.MAX_MODELS_PER_RUN) || undefined,
    verifiedModelSlug,
  });
  if (models.length < MIN_MODELS) {
    return bad("Not enough models are available to compare right now. Try again later.", 503);
  }
  const verifiedModel = models.find((m) => m.slug === verifiedModelSlug);

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
