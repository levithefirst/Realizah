// Server-side comparison flow:
// tool -> task understanding -> registry -> capability/budget filters ->
// candidate selection -> same task to each -> evaluation -> cost ->
// Cheaper cost / Better cost -> persisted audit trail.
import "server-only";
import { db } from "../db";
import { listProducts } from "../aiTools";
import { executionLimits } from "../config";
import { budgetLine } from "../budget";
import { assignLabels } from "../labels";
import { currentToolBaseline, matchProduct, type Baseline } from "../products";
import { configuredAdapters } from "../providers";
import { loadRegistry, registryStats } from "../registry/load";
import { lastRefresh, refreshRegistry } from "../registry/refresh";
import { selectCandidates, type SelectionResult } from "../selection/select";
import { understandTask, type TaskUnderstanding } from "../task/understand";
import { buildMessages, executeCandidates, type CandidateOutcome } from "./execute";
import type { Check } from "../evaluation/evaluate";
import { comparisonSummary } from "./summary";

export type ComparisonInput = {
  toolInput: string;
  useCase: string;
  task: string;
  budgetUsd: number | null;
  wordMaxOverride: number | null;
};

export type Plan = {
  product: { name: string; slug: string | null; capability: string | null };
  understanding: TaskUnderstanding;
  executable: boolean;
  reason: string | null;
  providersConfigured: string[];
  discoverableModels: number;
  capableInRegistry: number;
  candidateCount: number;
  candidates: { slug: string; name: string; creator: string; provider: string; reason: string }[];
  excluded: SelectionResult["excluded"];
  overUserBudget: SelectionResult["overUserBudget"];
  estimatedExecutionCostUsd: number;
  executionBudgetUsd: number;
  registryRefreshedAt: string | null;
  warnings: string[];
};

export type ResultDTO = {
  key: string;
  model: string;
  slug: string;
  creator: string;
  provider: string;
  externalModelId: string;
  priceStatus: string;
  inputUsdPer1m: number | null;
  outputUsdPer1m: number | null;
  priceObservedAt: string | null;
  executed: boolean;
  passed: boolean;
  estimatedCostUsd: number | null;
  costPerSuccessUsd: number | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  wordCount: number | null;
  finishReason: string | null;
  error: string | null;
  checks: Check[];
  failureReason: string | null;
  output: string;
  cheaperCost: boolean;
  betterCost: boolean;
  budget: ReturnType<typeof budgetLine> | null;
};

export type ComparisonDTO = {
  runId: string;
  createdAt: string;
  toolName: string;
  useCase: string;
  task: string;
  understanding: TaskUnderstanding;
  baseline: Baseline;
  candidateCount: number;
  attempted: number;
  succeeded: number;
  failed: number;
  budgetUsd: number | null;
  executionBudgetUsd: number;
  estimatedExecutionCostUsd: number;
  actualExecutionCostUsd: number;
  results: ResultDTO[];
  summary: string;
  warnings: string[];
};

async function ensureRegistry() {
  const stats = await registryStats();
  if (stats.discoverable === 0) await refreshRegistry();
}

export async function planComparison(input: ComparisonInput) {
  const products = await listProducts();
  const product = matchProduct(input.toolInput, products);
  const understanding = understandTask({ task: input.task, useCase: input.useCase, productCapability: product?.capability ?? null });
  const adapters = configuredAdapters();
  const limits = executionLimits();
  const productDTO = { name: product?.name ?? input.toolInput.trim(), slug: product?.slug ?? null, capability: product?.capability ?? null };
  const base = {
    product: productDTO,
    understanding,
    providersConfigured: [...adapters.keys()],
    executionBudgetUsd: limits.maxExecutionCostUsd,
    warnings: understanding.warnings,
  };

  if (!understanding.executable) {
    const stats = await registryStats().catch(() => null);
    return {
      plan: {
        ...base,
        executable: false,
        reason: understanding.notExecutableReason,
        discoverableModels: stats?.discoverable ?? 0,
        capableInRegistry: 0,
        candidateCount: 0,
        candidates: [],
        excluded: {},
        overUserBudget: [],
        estimatedExecutionCostUsd: 0,
        registryRefreshedAt: stats?.lastRefresh?.at ?? null,
      } satisfies Plan,
      selection: null,
      product,
      products,
    };
  }

  await ensureRegistry();
  const [registry, stats] = await Promise.all([loadRegistry(), registryStats()]);
  const selection = selectCandidates({
    registry,
    understanding,
    providers: new Set(adapters.keys()),
    limits,
    userBudgetUsd: input.budgetUsd,
  });

  let reason: string | null = null;
  if (adapters.size === 0) reason = "No execution provider is configured on the server (OPENROUTER_API_KEY or OPENAI_API_KEY).";
  else if (selection.candidates.length < 2)
    reason =
      selection.capableInRegistry === 0
        ? "No model in the registry can do this kind of task."
        : `Only ${selection.candidates.length} model(s) can run this task within the current providers and budgets, so there is nothing to compare.`;

  return {
    plan: {
      ...base,
      executable: reason === null,
      reason,
      discoverableModels: stats.discoverable,
      capableInRegistry: selection.capableInRegistry,
      candidateCount: selection.candidates.length,
      candidates: selection.candidates.map((c) => ({
        slug: c.model.slug,
        name: c.model.name,
        creator: c.model.creator,
        provider: c.access.providerId,
        reason: c.reason,
      })),
      excluded: selection.excluded,
      overUserBudget: selection.overUserBudget.slice(0, 10),
      estimatedExecutionCostUsd: selection.estimatedExecutionCostUsd,
      registryRefreshedAt: stats.lastRefresh?.at ?? null,
    } satisfies Plan,
    selection,
    product,
    products,
  };
}

function failureReason(o: CandidateOutcome): string | null {
  if (!o.run.ok) return o.run.error ?? "call failed";
  const failed = o.evaluation?.checks.filter((c) => c.status === "fail") ?? [];
  return failed.length ? failed.map((c) => c.detail).join(" ") : null;
}

export async function runComparison(input: ComparisonInput, ipHash: string, selection: SelectionResult, understanding: TaskUnderstanding, product: Awaited<ReturnType<typeof planComparison>>["product"]): Promise<ComparisonDTO> {
  const limits = executionLimits();
  const adapters = configuredAdapters();
  const messages = buildMessages(input.task);
  const outcomes = await executeCandidates({
    candidates: selection.candidates,
    messages,
    adapters,
    understanding,
    timeoutMs: limits.timeoutMs,
    maxConcurrent: limits.maxConcurrent,
    wordMaxOverride: input.wordMaxOverride,
  });

  const labelInput = outcomes.map((o) => ({
    key: o.candidate.model.id,
    label: o.candidate.model.name,
    passed: o.passed,
    estimatedCostUsd: o.estimatedCostUsd,
    costPerSuccessUsd: o.costPerSuccessUsd,
  }));
  const labels = assignLabels(labelInput);

  const verifiedOutcome = product?.verifiedModelId ? outcomes.find((o) => o.candidate.model.id === product.verifiedModelId) : null;
  const baseline = currentToolBaseline({
    input: input.toolInput,
    product,
    verifiedModelResult: verifiedOutcome ? { costUsd: verifiedOutcome.estimatedCostUsd } : null,
  });

  const attempted = outcomes.length;
  const succeeded = outcomes.filter((o) => o.passed).length;
  const actualCost = outcomes.reduce((s, o) => s + (o.estimatedCostUsd ?? 0), 0);
  const refresh = await lastRefresh();
  const nameOf = (id: string) => outcomes.find((o) => o.candidate.model.id === id)!.candidate.model.name;
  const cheaperNames = labels.cheaper.map(nameOf);
  const betterNames = labels.better.map(nameOf);
  const cheaperCost = outcomes.find((o) => o.candidate.model.id === labels.cheaper[0])?.estimatedCostUsd ?? null;
  const betterCost = outcomes.find((o) => o.candidate.model.id === labels.better[0])?.costPerSuccessUsd ?? null;
  const summary = comparisonSummary({
    attempted,
    cheaper: { names: cheaperNames, costUsd: cheaperCost },
    better: { names: betterNames, costPerSuccessUsd: betterCost },
    baseline,
  });

  const client = await db().connect();
  let runId: string;
  let createdAt: string;
  const results: ResultDTO[] = [];
  try {
    await client.query("begin");
    const run = await client.query<{ id: string; created_at: Date }>(
      `insert into comparison_runs (ai_tool_input, ai_tool_slug, use_case, task_text, task_understanding, baseline,
         budget_usd, execution_budget_usd, estimated_execution_cost_usd, actual_execution_cost_usd, candidate_count,
         models_attempted, models_succeeded, models_failed, registry_refresh_id, cheaper_cost_model_ids,
         better_cost_model_ids, status, ip_hash)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) returning id, created_at`,
      [
        input.toolInput,
        product?.slug ?? null,
        input.useCase,
        input.task,
        JSON.stringify(understanding),
        JSON.stringify(baseline),
        input.budgetUsd,
        selection.executionBudgetUsd,
        selection.estimatedExecutionCostUsd,
        actualCost,
        selection.candidates.length,
        attempted,
        succeeded,
        attempted - succeeded,
        refresh?.id ?? null,
        labels.cheaper,
        labels.better,
        outcomes.some((o) => !o.run.ok) ? "partial" : "complete",
        ipHash,
      ]
    );
    runId = run.rows[0].id;
    createdAt = run.rows[0].created_at.toISOString();

    for (const o of outcomes) {
      const c = o.candidate;
      const cand = await client.query<{ id: string }>(
        `insert into comparison_candidates (run_id, model_id, access_id, provider_id, external_model_id, price_id,
           input_usd_per_1m, output_usd_per_1m, price_status, selection_rank, selection_reason, max_output_tokens, worst_case_cost_usd)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
        [
          runId,
          c.model.id,
          c.access.accessId,
          c.access.providerId,
          c.access.externalModelId,
          c.access.priceId,
          c.access.inputUsdPer1m,
          c.access.outputUsdPer1m,
          c.access.priceStatus,
          c.rank,
          c.reason,
          c.maxOutputTokens,
          c.worstCaseCostUsd,
        ]
      );
      const candidateId = cand.rows[0].id;
      await client.query(
        `insert into comparison_results (run_id, candidate_id, executed, passed, input_tokens, output_tokens, total_tokens,
           input_usd_per_1m, output_usd_per_1m, estimated_cost_usd, provider_reported_cost_usd, cost_per_success_usd,
           latency_ms, finish_reason, evaluation, error)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          runId,
          candidateId,
          o.run.ok,
          o.passed,
          o.run.inputTokens,
          o.run.outputTokens,
          o.run.totalTokens,
          c.access.inputUsdPer1m,
          c.access.outputUsdPer1m,
          o.estimatedCostUsd,
          o.run.providerReportedCostUsd,
          o.costPerSuccessUsd,
          o.run.latencyMs,
          o.run.finishReason,
          JSON.stringify(o.evaluation?.checks ?? []),
          o.run.error,
        ]
      );
      const budget = input.budgetUsd !== null ? budgetLine(input.budgetUsd, o) : null;
      if (budget) {
        await client.query(
          `insert into budget_plans (run_id, candidate_id, budget_usd, cost_per_success_usd, successful_runs_within_budget, exceeds_budget, is_estimate)
           values ($1,$2,$3,$4,$5,$6,true)`,
          [runId, candidateId, budget.budgetUsd, o.costPerSuccessUsd, budget.successfulRunsWithinBudget, budget.exceedsBudget]
        );
      }
      if (o.run.ok) {
        await client.query(
          `insert into audit_events (comparison_run_id, model, provider_id, tokens_in, tokens_out, total_tokens,
             input_usd_per_1m, output_usd_per_1m, estimated_cost_usd, latency_ms, success, evaluation_passed)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            runId,
            c.model.slug,
            c.access.providerId,
            o.run.inputTokens,
            o.run.outputTokens,
            o.run.totalTokens,
            c.access.inputUsdPer1m,
            c.access.outputUsdPer1m,
            o.estimatedCostUsd,
            o.run.latencyMs,
            o.run.ok,
            o.passed,
          ]
        );
      }
      results.push({
        key: c.model.id,
        model: c.model.name,
        slug: c.model.slug,
        creator: c.model.creator,
        provider: c.access.providerId,
        externalModelId: c.access.externalModelId,
        priceStatus: c.access.priceStatus,
        inputUsdPer1m: c.access.inputUsdPer1m,
        outputUsdPer1m: c.access.outputUsdPer1m,
        priceObservedAt: c.access.priceObservedAt,
        executed: o.run.ok,
        passed: o.passed,
        estimatedCostUsd: o.estimatedCostUsd,
        costPerSuccessUsd: o.costPerSuccessUsd,
        latencyMs: o.run.latencyMs,
        inputTokens: o.run.inputTokens,
        outputTokens: o.run.outputTokens,
        totalTokens: o.run.totalTokens,
        wordCount: o.evaluation?.wordCount ?? null,
        finishReason: o.run.finishReason,
        error: o.run.error,
        checks: o.evaluation?.checks ?? [],
        failureReason: failureReason(o),
        output: o.run.text,
        cheaperCost: labels.cheaper.includes(c.model.id),
        betterCost: labels.better.includes(c.model.id),
        budget,
      });
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // 14-day retention for comparison data, as the privacy page states.
  db()
    .query(
      `delete from comparison_runs where created_at < now() - interval '14 days';
       delete from runs where created_at < now() - interval '14 days';
       delete from audit_events where created_at < now() - interval '14 days';
       delete from rate_limits where window_start < now() - interval '2 days';`
    )
    .catch(() => {});

  return {
    runId,
    createdAt,
    toolName: baseline.product,
    useCase: input.useCase,
    task: input.task,
    understanding,
    baseline,
    candidateCount: selection.candidates.length,
    attempted,
    succeeded,
    failed: attempted - succeeded,
    budgetUsd: input.budgetUsd,
    executionBudgetUsd: selection.executionBudgetUsd,
    estimatedExecutionCostUsd: selection.estimatedExecutionCostUsd,
    actualExecutionCostUsd: actualCost,
    results,
    summary,
    warnings: understanding.warnings,
  };
}
