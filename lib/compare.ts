import "server-only";
import { db } from "./db";
import type { Criteria } from "./checks";
import { assignLabels } from "./labels";
import { chat } from "./openai";
import { buildMessages, runModels, type AuditEvent, type ResultCard, type RunMode } from "./engine";
import type { Tool } from "./tools";

export type { AuditEvent, ResultCard, RunMode } from "./engine";

export type CompareResult = {
  runId: string;
  createdAt: string;
  currentTool: string;
  useCase: string;
  task: string;
  criteria: Criteria;
  results: ResultCard[];
  cheaperCostSlugs: string[];
  betterCostSlugs: string[];
  summary: string;
  audit: AuditEvent[];
  // custom: the user's task was sent as typed. demo: no task, sample ticket.
  mode: RunMode;
};

export async function compare(opts: {
  toolName: string;
  useCase: string;
  task: string;
  criteria: Criteria;
  // OpenAI models the task is priced on. None of them is assumed to be the
  // model behind the user's tool.
  models: Tool[];
  // Only set when ai_tools holds a verified mapping for the user's tool.
  verifiedModelSlug: string | null;
  fallback: Tool | undefined;
  ipHash: string;
}): Promise<CompareResult> {
  // The exact same prompt goes to every model.
  const prompt = buildMessages(opts.task);
  const outcomes = await runModels(opts.models, prompt.messages, opts.criteria, {
    fallback: opts.fallback,
    verifiedModelSlug: opts.verifiedModelSlug,
    call: chat,
  });
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
      `insert into runs (current_tool, use_case, task_text, success_criteria, recommended_slug, ip_hash)
       values ($1, $2, $3, $4, $5, $6) returning id, created_at`,
      [opts.toolName, opts.useCase, prompt.taskText, JSON.stringify({ ...opts.criteria, mode: prompt.mode }), labels.better[0] ?? null, opts.ipHash]
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
    currentTool: opts.toolName,
    useCase: opts.useCase,
    task: prompt.taskText,
    criteria: opts.criteria,
    results: cards,
    cheaperCostSlugs: labels.cheaper,
    betterCostSlugs: labels.better,
    summary: labels.summary,
    audit,
    mode: prompt.mode,
  };
}
