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
import { providerReadiness, recordAuthFailure, type ProviderStatus } from "../providers/readiness";
import type { ProviderAdapter } from "../providers/types";
import { loadRegistry, registryStats } from "../registry/load";
import { lastRefresh, refreshRegistry } from "../registry/refresh";
import { selectCandidates, type Candidate, type CandidateRole, type PriceTier, type SelectionResult } from "../selection/select";
import { applyWordMaxOverride, understandTask, type TaskUnderstanding } from "../task/understand";
import { buildMessages, type CandidateOutcome } from "./execute";
import { isLabelEligible, labelOutcomes, runProgressive, systemicFailure } from "./progressive";
import type { Check } from "../evaluation/evaluate";
import { comparisonSummary } from "./summary";

export type ComparisonInput = {
  toolInput: string;
  useCase: string;
  task: string;
  budgetUsd: number | null;
  wordMaxOverride: number | null;
};

export type CandidateDTO = {
  slug: string;
  name: string;
  creator: string;
  provider: string;
  role: CandidateRole;
  priceTier: PriceTier;
  worstCaseCostUsd: number;
  expectedCostUsd: number;
  reason: string;
};

export type Plan = {
  product: { name: string; slug: string | null; capability: string | null };
  understanding: TaskUnderstanding;
  executable: boolean;
  reason: string | null;
  // Providers that can execute (configured and not known to reject the key).
  providersConfigured: string[];
  providers: ProviderStatus[];
  discoverableModels: number;
  considered: number;
  capableInRegistry: number;
  // Paid models queued (at most maxCandidates run), and free screening runs.
  candidateCount: number;
  maxPaidRuns: number;
  minPaidRuns: number;
  screeningCount: number;
  candidates: CandidateDTO[];
  screening: CandidateDTO[];
  excluded: SelectionResult["excluded"];
  overUserBudget: SelectionResult["overUserBudget"];
  outputTokenCeiling: number;
  outputBudgetBasis: string;
  estimatedExecutionCostUsd: number;
  worstCaseCoreUsd: number;
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
  role: CandidateRole;
  priceTier: PriceTier;
  stage: number;
  priceStatus: string;
  inputUsdPer1m: number | null;
  outputUsdPer1m: number | null;
  priceObservedAt: string | null;
  executed: boolean;
  passed: boolean;
  labelEligible: boolean;
  estimatedCostUsd: number | null;
  worstCaseCostUsd: number;
  costPerSuccessUsd: number | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  maxOutputTokens: number;
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

export type SkippedDTO = { slug: string; name: string; provider: string; priceTier: PriceTier; worstCaseCostUsd: number; kind: string; reason: string };

export type ComparisonDTO = {
  runId: string;
  createdAt: string;
  toolName: string;
  useCase: string;
  task: string;
  understanding: TaskUnderstanding;
  baseline: Baseline;
  considered: number;
  filtered: SelectionResult["excluded"];
  queued: number;
  candidateCount: number;
  attempted: number;
  succeeded: number;
  failed: number;
  screeningRuns: number;
  skipped: SkippedDTO[];
  stopReason: string;
  labelsWithheld: string | null;
  // Set when no model returned a reply for reasons outside the user's task
  // (provider auth, network, timeouts). Such a run doesn't use a free comparison.
  systemicFailure: string | null;
  budgetUsd: number | null;
  executionBudgetUsd: number;
  estimatedExecutionCostUsd: number;
  actualExecutionCostUsd: number;
  chargedExecutionCostUsd: number;
  peakCommittedUsd: number;
  outputTokenCeiling: number;
  outputBudgetBasis: string;
  results: ResultDTO[];
  summary: string;
  warnings: string[];
};

async function ensureRegistry() {
  const stats = await registryStats();
  if (stats.discoverable === 0) await refreshRegistry();
}

const toDTO = (c: Candidate): CandidateDTO => ({
  slug: c.model.slug,
  name: c.model.name,
  creator: c.model.creator,
  provider: c.access.providerId,
  role: c.role,
  priceTier: c.priceTier,
  worstCaseCostUsd: c.worstCaseCostUsd,
  expectedCostUsd: c.expectedCostUsd,
  reason: c.reason,
});

// adapters: the providers allowed to execute. Defaults to the configured ones
// that pass the cached auth probe (at most one probe per provider per TTL per
// instance, shared by concurrent requests); /api/run passes the set it has
// just verified.
export async function planComparison(input: ComparisonInput, opts: { adapters?: Map<string, ProviderAdapter> } = {}) {
  const products = await listProducts();
  const product = matchProduct(input.toolInput, products);
  const understanding = applyWordMaxOverride(
    understandTask({ task: input.task, useCase: input.useCase, productCapability: product?.capability ?? null }),
    input.wordMaxOverride
  );
  const readiness = opts.adapters ? null : await providerReadiness({ verify: true });
  const adapters = opts.adapters ?? readiness!.ready;
  const limits = executionLimits();
  const productDTO = { name: product?.name ?? input.toolInput.trim(), slug: product?.slug ?? null, capability: product?.capability ?? null };
  const empty = {
    product: productDTO,
    understanding,
    providersConfigured: [...adapters.keys()],
    providers: readiness?.statuses ?? [...adapters.keys()].map((p) => ({ provider: p, state: "ready" as const, detail: null, checkedAt: null })),
    executionBudgetUsd: limits.maxExecutionCostUsd,
    maxPaidRuns: limits.maxCandidates,
    minPaidRuns: limits.minCandidates,
    warnings: understanding.warnings,
    considered: 0,
    capableInRegistry: 0,
    candidateCount: 0,
    screeningCount: 0,
    candidates: [],
    screening: [],
    excluded: {},
    overUserBudget: [],
    outputTokenCeiling: 0,
    outputBudgetBasis: "",
    estimatedExecutionCostUsd: 0,
    worstCaseCoreUsd: 0,
  };

  if (!understanding.executable) {
    const stats = await registryStats().catch(() => null);
    return {
      plan: {
        ...empty,
        executable: false,
        reason: understanding.notExecutableReason,
        discoverableModels: stats?.discoverable ?? 0,
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
    taskText: input.task,
  });

  let reason: string | null = null;
  if (adapters.size === 0) reason = "No model provider is available right now (OPENROUTER_API_KEY and OPENAI_API_KEY are missing, invalid or rejected).";
  else if (limits.maxExecutionCostUsd <= 0)
    reason = "Realizah's execution budget (MAX_EXECUTION_COST_USD) is $0, so no paid model can run. Free-tier screening alone can't produce cost labels.";
  else if (selection.candidates.length < 2)
    reason =
      selection.capableInRegistry === 0
        ? "No model in the registry can do this kind of task."
        : `Only ${selection.candidates.length} model(s) can run this task within the current providers and the $${limits.maxExecutionCostUsd} cap, so there is nothing to compare.`;

  return {
    plan: {
      ...empty,
      executable: reason === null,
      reason,
      discoverableModels: stats.discoverable,
      considered: selection.considered,
      capableInRegistry: selection.capableInRegistry,
      candidateCount: Math.min(selection.candidates.length, limits.maxCandidates),
      screeningCount: selection.screening.length,
      candidates: selection.candidates.map(toDTO),
      screening: selection.screening.map(toDTO),
      excluded: selection.excluded,
      overUserBudget: selection.overUserBudget.slice(0, 10),
      outputTokenCeiling: selection.plannedOutputTokens,
      outputBudgetBasis: selection.outputBudgetBasis,
      estimatedExecutionCostUsd: selection.estimatedExecutionCostUsd,
      worstCaseCoreUsd: selection.worstCaseCoreUsd,
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

export async function runComparison(
  input: ComparisonInput,
  ipHash: string,
  selection: SelectionResult,
  understanding: TaskUnderstanding,
  product: Awaited<ReturnType<typeof planComparison>>["product"],
  adaptersIn?: Map<string, ProviderAdapter>
): Promise<ComparisonDTO> {
  const limits = executionLimits();
  const adapters = adaptersIn ?? (await providerReadiness({ verify: false })).ready;
  const messages = buildMessages(input.task);
  const progress = await runProgressive({ selection, messages, adapters, understanding, limits, wordMaxOverride: input.wordMaxOverride });
  const outcomes = progress.outcomes;
  const eligible = outcomes.filter(isLabelEligible);
  // A provider that rejected every call's key is skipped by later plans.
  for (const f of progress.providerFailures) if (f.errorKind === "auth") recordAuthFailure(f.providerId, f.message);
  const systemic = systemicFailure(progress);
  const labels = labelOutcomes(outcomes, assignLabels);

  const verifiedOutcome = product?.verifiedModelId ? eligible.find((o) => o.candidate.model.id === product.verifiedModelId) : null;
  const baseline = currentToolBaseline({
    input: input.toolInput,
    product,
    verifiedModelResult: verifiedOutcome ? { costUsd: verifiedOutcome.estimatedCostUsd } : null,
  });

  const attempted = eligible.length;
  const succeeded = eligible.filter((o) => o.passed).length;
  const refresh = await lastRefresh();
  const byId = (id: string) => eligible.find((o) => o.candidate.model.id === id)!;
  let summary = comparisonSummary({
    attempted,
    cheaper: { names: labels.cheaper.map((id) => byId(id).candidate.model.name), costUsd: labels.cheaper[0] ? byId(labels.cheaper[0]).estimatedCostUsd : null },
    better: { names: labels.better.map((id) => byId(id).candidate.model.name), costPerSuccessUsd: labels.better[0] ? byId(labels.better[0]).costPerSuccessUsd : null },
    baseline,
  });
  if (labels.withheld) summary = `No cost labels: ${labels.withheld}`;
  if (systemic) summary = `No model returned a reply: ${systemic}. This run did not use one of your free comparisons.`;

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
         better_cost_model_ids, status, ip_hash, candidates_considered, candidates_filtered, candidates_queued,
         candidates_skipped, screening_runs, charged_execution_cost_usd, peak_committed_usd, output_token_ceiling,
         output_budget_basis, stop_reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
       returning id, created_at`,
      [
        input.toolInput,
        product?.slug ?? null,
        input.useCase,
        input.task,
        JSON.stringify(understanding),
        JSON.stringify(baseline),
        input.budgetUsd,
        limits.maxExecutionCostUsd,
        selection.estimatedExecutionCostUsd,
        progress.ledger.actualUsd,
        attempted,
        attempted,
        succeeded,
        attempted - succeeded,
        refresh?.id ?? null,
        labels.cheaper,
        labels.better,
        outcomes.some((o) => !o.run.ok) || progress.skipped.some((x) => x.kind === "budget") ? "partial" : "complete",
        ipHash,
        selection.considered,
        JSON.stringify(selection.excluded),
        selection.candidates.length,
        progress.skipped.length,
        outcomes.length - eligible.length,
        progress.ledger.chargedUsd,
        progress.ledger.peakCommittedUsd,
        selection.plannedOutputTokens,
        selection.outputBudgetBasis,
        progress.stopReason,
      ]
    );
    runId = run.rows[0].id;
    createdAt = run.rows[0].created_at.toISOString();

    const insertCandidate = async (c: Candidate, status: "executed" | "skipped", stage: number | null, skipReason: string | null) =>
      (
        await client.query<{ id: string }>(
          `insert into comparison_candidates (run_id, model_id, access_id, provider_id, external_model_id, price_id,
             input_usd_per_1m, output_usd_per_1m, price_status, selection_rank, selection_reason, max_output_tokens,
             worst_case_cost_usd, expected_cost_usd, role, price_tier, stage, status, skip_reason)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) returning id`,
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
            c.expectedCostUsd,
            c.role,
            c.priceTier,
            stage,
            status,
            skipReason,
          ]
        )
      ).rows[0].id;

    for (const sk of progress.skipped) await insertCandidate(sk.candidate, "skipped", null, `${sk.kind}: ${sk.reason}`);

    for (const o of outcomes) {
      const c = o.candidate;
      const candidateId = await insertCandidate(c, "executed", o.stage, null);
      const isEligible = isLabelEligible(o);
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
          isEligible ? o.costPerSuccessUsd : null,
          o.run.latencyMs,
          o.run.finishReason,
          JSON.stringify(o.evaluation?.checks ?? []),
          o.run.error,
        ]
      );
      const budget = input.budgetUsd !== null && isEligible ? budgetLine(input.budgetUsd, o) : null;
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
          [runId, c.model.slug, c.access.providerId, o.run.inputTokens, o.run.outputTokens, o.run.totalTokens, c.access.inputUsdPer1m, c.access.outputUsdPer1m, o.estimatedCostUsd, o.run.latencyMs, o.run.ok, o.passed]
        );
      }
      results.push({
        key: `${c.model.id}:${c.access.externalModelId}`,
        model: c.model.name,
        slug: c.model.slug,
        creator: c.model.creator,
        provider: c.access.providerId,
        externalModelId: c.access.externalModelId,
        role: c.role,
        priceTier: c.priceTier,
        stage: o.stage,
        priceStatus: c.access.priceStatus,
        inputUsdPer1m: c.access.inputUsdPer1m,
        outputUsdPer1m: c.access.outputUsdPer1m,
        priceObservedAt: c.access.priceObservedAt,
        executed: o.run.ok,
        passed: o.passed,
        labelEligible: isEligible,
        estimatedCostUsd: o.estimatedCostUsd,
        worstCaseCostUsd: c.worstCaseCostUsd,
        costPerSuccessUsd: isEligible ? o.costPerSuccessUsd : null,
        latencyMs: o.run.latencyMs,
        inputTokens: o.run.inputTokens,
        outputTokens: o.run.outputTokens,
        totalTokens: o.run.totalTokens,
        maxOutputTokens: c.maxOutputTokens,
        wordCount: o.evaluation?.wordCount ?? null,
        finishReason: o.run.finishReason,
        error: o.run.error,
        checks: o.evaluation?.checks ?? [],
        failureReason: failureReason(o),
        output: o.run.text,
        cheaperCost: isEligible && labels.cheaper.includes(c.model.id),
        betterCost: isEligible && labels.better.includes(c.model.id),
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

  // Remember access paths the provider said it can't serve on chat completions.
  const unsupported = outcomes.filter((o) => o.run.errorKind === "unsupported_endpoint");
  if (unsupported.length) {
    db()
      .query(
        `update model_provider_access set chat_supported = false, chat_supported_detail = x.detail, chat_supported_checked_at = now()
           from jsonb_to_recordset($1::jsonb) as x(id uuid, detail text) where model_provider_access.id = x.id`,
        [JSON.stringify(unsupported.map((o) => ({ id: o.candidate.access.accessId, detail: o.run.error })))]
      )
      .catch(() => {});
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

  // Paid results first in execution order, then screening runs.
  results.sort((a, b) => Number(b.labelEligible) - Number(a.labelEligible) || a.stage - b.stage);

  return {
    runId,
    createdAt,
    toolName: baseline.product,
    useCase: input.useCase,
    task: input.task,
    understanding,
    baseline,
    considered: selection.considered,
    filtered: selection.excluded,
    queued: selection.candidates.length,
    candidateCount: attempted,
    attempted,
    succeeded,
    failed: attempted - succeeded,
    screeningRuns: outcomes.length - eligible.length,
    skipped: progress.skipped.map((x) => ({
      slug: x.candidate.model.slug,
      name: x.candidate.model.name,
      provider: x.candidate.access.providerId,
      priceTier: x.candidate.priceTier,
      worstCaseCostUsd: x.candidate.worstCaseCostUsd,
      kind: x.kind,
      reason: x.reason,
    })),
    stopReason: progress.stopReason,
    labelsWithheld: labels.withheld,
    systemicFailure: systemic,
    budgetUsd: input.budgetUsd,
    executionBudgetUsd: limits.maxExecutionCostUsd,
    estimatedExecutionCostUsd: selection.estimatedExecutionCostUsd,
    actualExecutionCostUsd: progress.ledger.actualUsd,
    chargedExecutionCostUsd: progress.ledger.chargedUsd,
    peakCommittedUsd: progress.ledger.peakCommittedUsd,
    outputTokenCeiling: selection.plannedOutputTokens,
    outputBudgetBasis: selection.outputBudgetBasis,
    results,
    summary,
    warnings: understanding.warnings,
  };
}
