// Operator export of accumulated comparison evidence: every run with its task
// understanding, candidates (executed and skipped), results, checks, costs,
// billing audit and stored replies. Raw records only: no aggregation, no
// ranking, never the IP hash. Content scrubbed by retention comes back empty
// with contentDeleted: true.
import "server-only";
import { db } from "../db";

export type ExportQuery = { since: Date | null; until: Date | null; limit: number; cursor: Date | null };

export function parseExportQuery(q: URLSearchParams): { ok: true; query: ExportQuery } | { ok: false; error: string } {
  const date = (k: string): Date | null | "bad" => {
    const v = q.get(k);
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? "bad" : d;
  };
  const since = date("since");
  const until = date("until");
  const cursor = date("cursor");
  if (since === "bad" || until === "bad" || cursor === "bad") return { ok: false, error: "since, until and cursor must be ISO dates." };
  const limit = q.get("limit") ? Number(q.get("limit")) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return { ok: false, error: "limit must be a whole number from 1 to 200." };
  return { ok: true, query: { since, until, limit, cursor } };
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function exportRuns(q: ExportQuery) {
  const { rows: runs } = await db().query<any>(
    `select id, created_at, ai_tool_input, ai_tool_slug, use_case, task_text, task_understanding, status, stop_reason,
            execution_budget_usd, estimated_execution_cost_usd, actual_execution_cost_usd, charged_execution_cost_usd,
            peak_committed_usd, output_token_ceiling, output_budget_basis, candidates_considered, candidates_filtered,
            candidates_queued, candidates_skipped, screening_runs, models_attempted, models_succeeded, models_failed,
            cheaper_cost_model_ids, better_cost_model_ids, content_deleted_at
       from comparison_runs
      where ($1::timestamptz is null or created_at >= $1)
        and ($2::timestamptz is null or created_at < $2)
        and ($3::timestamptz is null or created_at < $3)
      order by created_at desc
      limit $4`,
    [q.since, q.until, q.cursor, q.limit + 1]
  );
  const page = runs.slice(0, q.limit);
  const ids = page.map((r) => r.id);
  const { rows: cands } = ids.length
    ? await db().query<any>(
        `select c.run_id, c.model_id, m.slug, m.creator, c.provider_id, c.external_model_id, c.role, c.price_tier, c.stage,
                c.status, c.skip_reason, c.selection_rank, c.max_output_tokens, c.worst_case_cost_usd, c.expected_cost_usd,
                c.input_usd_per_1m, c.output_usd_per_1m, c.price_status,
                res.id as result_id, res.executed, res.passed, res.input_tokens, res.output_tokens, res.total_tokens,
                res.estimated_cost_usd, res.provider_reported_cost_usd, res.reserved_cost_usd, res.billed_cost_usd,
                res.over_reservation, res.cost_per_success_usd, res.latency_ms, res.finish_reason, res.evaluation, res.error,
                o.output_text, o.checks as full_checks
           from comparison_candidates c
           join models m on m.id = c.model_id
           left join comparison_results res on res.candidate_id = c.id
           left join comparison_outputs o on o.result_id = res.id
          where c.run_id = any($1::uuid[])
          order by c.run_id, c.stage nulls last, c.selection_rank`,
        [ids]
      )
    : { rows: [] };

  return {
    generatedAt: new Date().toISOString(),
    count: page.length,
    nextCursor: runs.length > q.limit ? new Date(page[page.length - 1].created_at).toISOString() : null,
    runs: page.map((r) => ({
      runId: r.id,
      createdAt: new Date(r.created_at).toISOString(),
      contentDeleted: r.content_deleted_at !== null,
      tool: { input: r.ai_tool_input, slug: r.ai_tool_slug },
      useCase: r.use_case,
      task: r.task_text,
      understanding: r.task_understanding,
      status: r.status,
      stopReason: r.stop_reason,
      outputTokenCeiling: r.output_token_ceiling,
      outputBudgetBasis: r.output_budget_basis,
      counts: {
        considered: r.candidates_considered,
        queued: r.candidates_queued,
        skipped: r.candidates_skipped,
        screeningRuns: r.screening_runs,
        paidAttempted: r.models_attempted,
        paidPassed: r.models_succeeded,
        paidFailed: r.models_failed,
      },
      filtered: r.candidates_filtered,
      costs: {
        executionBudgetUsd: num(r.execution_budget_usd),
        estimatedUsd: num(r.estimated_execution_cost_usd),
        actualUsd: num(r.actual_execution_cost_usd),
        chargedUsd: num(r.charged_execution_cost_usd),
        peakCommittedUsd: num(r.peak_committed_usd),
      },
      labels: { cheaperCostModelIds: r.cheaper_cost_model_ids, betterCostModelIds: r.better_cost_model_ids },
      candidates: cands
        .filter((c) => c.run_id === r.id)
        .map((c) => ({
          modelId: c.model_id,
          slug: c.slug,
          creator: c.creator,
          provider: c.provider_id,
          externalModelId: c.external_model_id,
          role: c.role,
          priceTier: c.price_tier,
          stage: c.stage,
          status: c.status,
          skipReason: c.skip_reason,
          maxOutputTokens: c.max_output_tokens,
          worstCaseCostUsd: num(c.worst_case_cost_usd),
          expectedCostUsd: num(c.expected_cost_usd),
          price: { inputUsdPer1m: num(c.input_usd_per_1m), outputUsdPer1m: num(c.output_usd_per_1m), status: c.price_status },
          result: c.result_id
            ? {
                executed: c.executed,
                passed: c.passed,
                // Full wording while the content is retained; content-free after.
                checks: c.full_checks ?? c.evaluation,
                inputTokens: c.input_tokens,
                outputTokens: c.output_tokens,
                totalTokens: c.total_tokens,
                estimatedCostUsd: num(c.estimated_cost_usd),
                providerReportedCostUsd: num(c.provider_reported_cost_usd),
                reservedCostUsd: num(c.reserved_cost_usd),
                billedCostUsd: num(c.billed_cost_usd),
                overReservation: c.over_reservation,
                costPerSuccessUsd: num(c.cost_per_success_usd),
                latencyMs: c.latency_ms,
                finishReason: c.finish_reason,
                error: c.error,
                output: c.output_text ?? null,
              }
            : null,
        })),
    })),
  };
}
