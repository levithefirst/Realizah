import "server-only";
import { db } from "./db";
import { FIXTURE } from "./fixture";
import { runChecks, type Criteria } from "./checks";
import { estimateCostUsd } from "./cost";
import { assignLabels } from "./labels";
import { chat, ModelNotFoundError } from "./openai";
import type { Tool } from "./tools";

const FALLBACK_MODEL = "gpt-4o-mini";
const DEFAULT_TEMPERATURE = 0.2;
const FALLBACK_TEMPERATURE = 0.9;

export type ResultCard = {
  slug: string;
  label: string;
  modelId: string;
  isCurrent: boolean;
  fallbackFor: string | null;
  passed: boolean | null;
  qualityBand: "good" | "fail" | "error";
  wordCount: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  estimatedCostUsd: number | null;
  costPerSuccessUsd: number | null;
  latencyMs: number | null;
  priceUnknown: boolean;
  priceAsOf: string | null;
  error: string | null;
  why: string;
  output: string | null;
  // Cheaper cost: lowest estimated dollars for this run, pass or fail.
  cheaperCost: boolean;
  // Better cost: lowest dollars per successful outcome. A fail never gets it.
  betterCost: boolean;
};

export type AuditEvent = {
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  estimatedCostUsd: number | null;
  success: boolean | null;
  createdAt: string;
};

export type CompareResult = {
  runId: string;
  createdAt: string;
  currentTool: string;
  task: string;
  criteria: Criteria;
  results: ResultCard[];
  cheaperCostSlugs: string[];
  betterCostSlugs: string[];
  summary: string;
  audit: AuditEvent[];
};

function systemPrompt(task: string, c: Criteria): string {
  return [
    "You are doing a task for a user on the document they provide.",
    `Task: ${task}`,
    `Keep the answer to ${c.wordCap} words or fewer.`,
    "Use only facts in the document. Reply with the answer only.",
  ].join("\n");
}

async function runOne(
  tool: Tool,
  fallbackTool: Tool | undefined,
  task: string,
  c: Criteria,
  isCurrent: boolean
): Promise<{ card: ResultCard; audit: AuditEvent | null; auditModel: string }> {
  const base = {
    isCurrent,
    cheaperCost: false,
    betterCost: false,
    priceAsOf: tool.lastChecked,
  };
  const system = systemPrompt(task, c);

  let used: Tool = tool;
  let temperature = DEFAULT_TEMPERATURE;
  let fallbackFor: string | null = null;
  let completion;
  try {
    try {
      completion = await chat({ model: tool.modelId, system, user: FIXTURE, temperature });
    } catch (e) {
      if (!(e instanceof ModelNotFoundError) || !fallbackTool || tool.modelId === FALLBACK_MODEL) {
        throw e;
      }
      // Requested model id is not available on this key: run gpt-4o-mini at a
      // different temperature instead and label it so nobody is misled.
      used = fallbackTool;
      temperature = FALLBACK_TEMPERATURE;
      fallbackFor = tool.modelId;
      completion = await chat({ model: used.modelId, system, user: FIXTURE, temperature });
    }
  } catch (e) {
    const msg =
      e instanceof Error
        ? e.name === "TimeoutError"
          ? "timed out after 25s"
          : e.message
        : "unknown error";
    return {
      card: {
        ...base,
        slug: tool.slug,
        label: tool.name,
        modelId: tool.modelId,
        fallbackFor: null,
        passed: false,
        qualityBand: "error",
        wordCount: null,
        tokensIn: null,
        tokensOut: null,
        estimatedCostUsd: null,
        costPerSuccessUsd: null,
        latencyMs: null,
        priceUnknown: tool.isUnknown,
        error: msg,
        why: `Call failed: ${msg}`,
        output: null,
      },
      audit: null,
      auditModel: tool.modelId,
    };
  }

  const check = runChecks(completion.text, c);
  const cost = estimateCostUsd(
    completion.tokensIn,
    completion.tokensOut,
    used.inputUsdPer1m,
    used.outputUsdPer1m
  );
  const why = check.passed
    ? `Passed: ${check.wordCount} words (cap ${c.wordCap}), no banned phrase.`
    : `Failed: ${check.reasons.join("; ")}.`;

  const slug = fallbackFor ? `${used.slug}@t${temperature}` : tool.slug;
  const label = fallbackFor
    ? `${used.name} at temperature ${temperature} (fallback: ${fallbackFor} unavailable)`
    : tool.name;

  return {
    card: {
      ...base,
      slug,
      label,
      modelId: used.modelId,
      fallbackFor,
      passed: check.passed,
      qualityBand: check.passed ? "good" : "fail",
      wordCount: check.wordCount,
      tokensIn: completion.tokensIn,
      tokensOut: completion.tokensOut,
      estimatedCostUsd: cost,
      costPerSuccessUsd: check.passed ? cost : null,
      latencyMs: completion.latencyMs,
      priceUnknown: cost === null,
      priceAsOf: used.lastChecked,
      error: null,
      why,
      output: completion.text,
    },
    audit: {
      model: used.modelId,
      tokensIn: completion.tokensIn,
      tokensOut: completion.tokensOut,
      estimatedCostUsd: cost,
      success: check.passed,
      createdAt: new Date().toISOString(),
    },
    auditModel: used.modelId,
  };
}

export async function compare(opts: {
  currentTool: string;
  task: string;
  criteria: Criteria;
  current: Tool;
  alternatives: Tool[];
  fallback: Tool | undefined;
  ipHash: string;
}): Promise<CompareResult> {
  const selected = [
    { tool: opts.current, isCurrent: true },
    ...opts.alternatives.map((tool) => ({ tool, isCurrent: false })),
  ];
  const outcomes = await Promise.all(
    selected.map((s) => runOne(s.tool, opts.fallback, opts.task, opts.criteria, s.isCurrent))
  );
  const cards = outcomes.map((o) => o.card);
  const labels = assignLabels(cards);

  const client = await db().connect();
  let runId: string;
  let createdAt: string;
  const audit: AuditEvent[] = [];
  try {
    await client.query("begin");
    // recommended_slug holds the Better cost slug (lowest $ per success), or null.
    const run = await client.query<{ id: string; created_at: Date }>(
      `insert into runs (current_tool, task_text, success_criteria, recommended_slug, ip_hash)
       values ($1, $2, $3, $4, $5) returning id, created_at`,
      [opts.currentTool, opts.task, JSON.stringify(opts.criteria), labels.better[0] ?? null, opts.ipHash]
    );
    runId = run.rows[0].id;
    createdAt = run.rows[0].created_at.toISOString();
    for (const o of outcomes) {
      const c = o.card;
      await client.query(
        `insert into run_results (run_id, tool_slug, passed, quality_band, estimated_cost_usd,
                                  cost_per_success_usd, latency_ms, error)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [runId, c.slug, c.passed, c.qualityBand, c.estimatedCostUsd, c.costPerSuccessUsd, c.latencyMs, c.error]
      );
      if (o.audit) {
        const ev = await client.query<{ created_at: Date }>(
          `insert into audit_events (run_id, model, tokens_in, tokens_out, estimated_cost_usd, success)
           values ($1, $2, $3, $4, $5, $6) returning created_at`,
          [runId, o.audit.model, o.audit.tokensIn, o.audit.tokensOut, o.audit.estimatedCostUsd, o.audit.success]
        );
        audit.push({ ...o.audit, createdAt: ev.rows[0].created_at.toISOString() });
      }
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // 14-day retention, enforced opportunistically on each run.
  db()
    .query(
      `delete from runs where created_at < now() - interval '14 days';
       delete from audit_events where created_at < now() - interval '14 days';
       delete from rate_limits where window_start < now() - interval '2 days';`
    )
    .catch(() => {});

  return {
    runId,
    createdAt,
    currentTool: opts.currentTool,
    task: opts.task,
    criteria: opts.criteria,
    results: cards,
    cheaperCostSlugs: labels.cheaper,
    betterCostSlugs: labels.better,
    summary: labels.summary,
    audit,
  };
}
