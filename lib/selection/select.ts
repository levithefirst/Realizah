// Candidate selection: everything here happens BEFORE any model call, from
// registry data only. It produces an ordered queue; the progressive runner
// (comparison/progressive.ts) decides how much of it actually executes.
//
// 1. Capability   output modality, text input, context window, output capacity
// 2. Access       configured provider, known price, not a known-incompatible id
// 3. Cost         worst case per model within MAX_COST_PER_CANDIDATE_USD and the
//                 run cap; then the user's per-task budget
// 4. Relevance    task-relevant benchmark, verified capabilities, freshness
//                 (signals only; nothing is ranked as a winner)
// 5. Dedupe       one model per family (dated snapshots, variants)
// 6. Tiers        low / mid / high by worst-case cost, so no tier is skipped
// 7. Queue        a diverse core (one per tier, distinct creators), then
//                 expansion in creator round-robin order
// Free-tier variants are kept apart as screening runs: shown, never labeled.
//
// Pure: no database, no env, no network.
import type { ExecutionLimits } from "../config";
import { expectedInputTokens, taskCostUsd, worstCaseCostUsd, worstCaseInputTokens } from "../pricing";
import type { RegistryAccess, RegistryModel } from "../registry/types";
import { expectedOutputTokens, outputBudget, outputTokensFor } from "../task/outputBudget";
import type { TaskUnderstanding } from "../task/understand";

export type CandidateRole = "free_screening" | "core" | "expansion";
export type PriceTier = "free" | "low" | "mid" | "high";

export type Candidate = {
  model: RegistryModel;
  access: RegistryAccess;
  maxOutputTokens: number;
  worstCaseCostUsd: number;
  expectedCostUsd: number;
  relevance: number;
  rank: number;
  role: CandidateRole;
  priceTier: PriceTier;
  reason: string;
};

export type ExclusionReason =
  | "wrong_modality"
  | "context_too_small"
  | "output_limit_too_small"
  | "no_configured_provider"
  | "incompatible_access"
  | "free_tier_only"
  | "price_unknown"
  | "excessive_cost"
  | "exceeds_user_budget"
  | "near_duplicate"
  | "beyond_queue";

export type SelectionResult = {
  // Paid queue in execution order (core first, then expansion), plus free
  // screening runs. Nothing here has run yet.
  candidates: Candidate[];
  screening: Candidate[];
  considered: number;
  capableInRegistry: number;
  excluded: Partial<Record<ExclusionReason, number>>;
  overUserBudget: { slug: string; worstCaseCostUsd: number }[];
  tiersAvailable: PriceTier[];
  creatorsAvailable: number;
  plannedOutputTokens: number;
  outputBudgetBasis: string;
  // Expected spend of the core set (an estimate; the cap uses worst cases).
  estimatedExecutionCostUsd: number;
  worstCaseCoreUsd: number;
  executionBudgetUsd: number;
  target: number;
};

const BENCHMARK_FOR: Record<string, string> = { coding: "coding_index", mathematics: "math_index" };
const REASONING_TASKS = new Set(["reasoning", "mathematics", "analysis", "coding", "research"]);

// Free means no charge for the call: a ":free" variant, or any route with a
// known $0 input, $0 output and no per-request fee. Free routes may only be
// free-screening runs; they never take a paid role or a cost label.
export function isFreeAccess(a: RegistryAccess): boolean {
  if (a.externalModelId.endsWith(":free")) return true;
  return a.priceStatus !== "unknown" && a.inputUsdPer1m === 0 && a.outputUsdPer1m === 0 && (a.requestUsd ?? 0) === 0;
}

// "openai/gpt-4o-mini-2024-07-18" and "openai/gpt-4o-mini" are one family;
// so are variants like ":thinking" or ":beta". One per family.
export function familyKey(slug: string): string {
  return slug
    .replace(/:[a-z-]+$/i, "")
    .replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8}|\d{4}|\d{2}-\d{2})$/i, "")
    .replace(/-(?:preview|latest|exp|experimental)$/i, "")
    .toLowerCase();
}

function count(e: SelectionResult["excluded"], r: ExclusionReason, n = 1) {
  e[r] = (e[r] ?? 0) + n;
}

type Scored = {
  m: RegistryModel;
  access: RegistryAccess;
  maxOut: number;
  worst: number;
  expected: number;
  score: number;
  reasons: string[];
};

export function selectCandidates(opts: {
  registry: RegistryModel[];
  understanding: TaskUnderstanding;
  providers: ReadonlySet<string>;
  limits: ExecutionLimits;
  userBudgetUsd?: number | null;
  // The exact task text, for the byte-level input bound.
  taskText?: string;
  now?: Date;
}): SelectionResult {
  const { understanding: u, limits } = opts;
  const now = opts.now ?? new Date();
  const excluded: SelectionResult["excluded"] = {};
  const budget = outputBudget(u, limits);
  const planned = budget.tokens;
  const worstIn = opts.taskText !== undefined ? worstCaseInputTokens(opts.taskText) : u.constraints.estimatedInputTokens * 4 + 16;
  const expectedIn = opts.taskText !== undefined ? expectedInputTokens(opts.taskText) : u.constraints.estimatedInputTokens + 16;
  const perCandidateCap = Math.min(limits.maxCostPerCandidateUsd, limits.maxExecutionCostUsd);

  // 1. Capability.
  const capable: { m: RegistryModel; maxOut: number }[] = [];
  for (const m of opts.registry) {
    if (m.status !== "active") continue;
    // Text tasks go to text-only models; media generators that also emit
    // text are not substitutes.
    const outputOk =
      u.outputModality === "text" ? m.outputModalities.length === 1 && m.outputModalities[0] === "text" : m.outputModalities.includes(u.outputModality);
    if (!outputOk || !m.inputModalities.includes("text")) {
      count(excluded, "wrong_modality");
      continue;
    }
    const maxOut = outputTokensFor(m.capabilities.includes("reasoning"), planned, limits, m.maxOutputTokens);
    if (m.maxOutputTokens !== null && m.maxOutputTokens < planned) {
      count(excluded, "output_limit_too_small");
      continue;
    }
    if (m.contextWindow !== null && m.contextWindow < worstIn + maxOut) {
      count(excluded, "context_too_small");
      continue;
    }
    capable.push({ m, maxOut });
  }

  // 2 + 3. Access and cost preflight.
  const paid: Omit<Scored, "score" | "reasons">[] = [];
  const freeOptions: Omit<Scored, "score" | "reasons">[] = [];
  const overUserBudget: SelectionResult["overUserBudget"] = [];
  for (const { m, maxOut } of capable) {
    const configured = m.access.filter((a) => opts.providers.has(a.providerId));
    if (!configured.length) {
      count(excluded, "no_configured_provider");
      continue;
    }
    const usable = configured.filter((a) => a.chatSupported !== false);
    if (!usable.length) {
      count(excluded, "incompatible_access");
      continue;
    }
    for (const a of usable.filter(isFreeAccess)) {
      if (a.priceStatus !== "unknown" && a.inputUsdPer1m === 0 && a.outputUsdPer1m === 0) {
        freeOptions.push({ m, access: a, maxOut, worst: 0, expected: 0 });
      }
    }
    const paidPaths = usable.filter((a) => !isFreeAccess(a) && a.priceStatus !== "unknown");
    if (!paidPaths.length) {
      count(excluded, usable.some((a) => !isFreeAccess(a)) ? "price_unknown" : "free_tier_only");
      continue;
    }
    let best: Omit<Scored, "score" | "reasons"> | null = null;
    for (const a of paidPaths) {
      const worst = worstCaseCostUsd(worstIn, maxOut, a);
      if (worst === null) continue;
      const expected = taskCostUsd(expectedIn, expectedOutputTokens(u, maxOut), a) ?? worst;
      const better =
        !best || worst < best.worst - 1e-12 || (Math.abs(worst - best.worst) <= 1e-12 && best.access.providerId === "openrouter" && a.providerId !== "openrouter");
      if (better) best = { m, access: a, maxOut, worst, expected };
    }
    if (!best) {
      count(excluded, "price_unknown");
      continue;
    }
    if (best.worst > perCandidateCap) {
      count(excluded, "excessive_cost");
      continue;
    }
    if (opts.userBudgetUsd != null && best.worst > opts.userBudgetUsd) {
      overUserBudget.push({ slug: m.slug, worstCaseCostUsd: best.worst });
      count(excluded, "exceeds_user_budget");
      continue;
    }
    paid.push(best);
  }

  // 4. Relevance signals.
  const metric = BENCHMARK_FOR[u.primary] ?? "intelligence_index";
  const maxBench = Math.max(0, ...[...paid, ...freeOptions].map((p) => p.m.benchmarks[metric] ?? 0));
  const score = (p: Omit<Scored, "score" | "reasons">): Scored => {
    const reasons: string[] = [];
    let s = 0.3;
    const b = p.m.benchmarks[metric];
    if (b !== undefined && maxBench > 0) {
      s += 0.4 * (b / maxBench);
      reasons.push(`${metric.replace(/_/g, " ")} ${Math.round(b * 10) / 10}`);
    } else s += 0.15;
    const caps = new Set(p.m.capabilities);
    if (REASONING_TASKS.has(u.primary) && caps.has("reasoning")) {
      s += 0.15;
      reasons.push("reasoning");
    }
    if ((u.primary === "structured_json" || u.constraints.outputFormat === "json") && caps.has("structured_output")) {
      s += 0.15;
      reasons.push("structured output");
    }
    if (p.m.releaseDate) {
      const age = (now.getTime() - new Date(p.m.releaseDate).getTime()) / 86_400_000;
      s += age <= 365 ? 0.1 : age <= 730 ? 0.05 : 0;
    }
    return { ...p, score: s, reasons };
  };

  // 5. One per family.
  const dedupe = (rows: Scored[], tally: boolean) => {
    const byFamily = new Map<string, Scored>();
    for (const r of rows) {
      const k = familyKey(r.m.slug);
      const prev = byFamily.get(k);
      if (!prev || r.score > prev.score || (r.score === prev.score && (r.m.releaseDate ?? "") > (prev.m.releaseDate ?? ""))) {
        if (prev && tally) count(excluded, "near_duplicate");
        byFamily.set(k, r);
      } else if (tally) count(excluded, "near_duplicate");
    }
    return [...byFamily.values()];
  };
  const pool = dedupe(paid.map(score), true);

  // 6. Price tiers by worst-case cost (terciles of the eligible pool).
  const byCost = [...pool].sort((a, b) => a.worst - b.worst);
  const tierOf = new Map<string, PriceTier>();
  byCost.forEach((p, i) => {
    const t: PriceTier = byCost.length < 3 ? (i === 0 ? "low" : i === byCost.length - 1 ? "high" : "mid") : i < byCost.length / 3 ? "low" : i < (2 * byCost.length) / 3 ? "mid" : "high";
    tierOf.set(p.m.slug, t);
  });
  const tiersAvailable = (["low", "mid", "high"] as PriceTier[]).filter((t) => [...tierOf.values()].includes(t));

  // 7. Queue: diverse core, then creator round-robin expansion.
  const byCreator = new Map<string, Scored[]>();
  for (const p of pool) byCreator.set(p.m.creator, [...(byCreator.get(p.m.creator) ?? []), p]);
  for (const list of byCreator.values()) list.sort((a, b) => b.score - a.score || a.worst - b.worst);
  const creators = [...byCreator.entries()].sort((a, b) => b[1][0].score - a[1][0].score).map(([c]) => c);

  const core: Scored[] = [];
  const usedCreators = new Set<string>();
  const pickFrom = (rows: Scored[]) => {
    const fresh = rows.filter((r) => !core.includes(r));
    return fresh.find((r) => !usedCreators.has(r.m.creator)) ?? fresh[0];
  };
  const take = (r: Scored | undefined) => {
    if (!r) return;
    core.push(r);
    usedCreators.add(r.m.creator);
  };
  // One per tier, most relevant first within the tier.
  for (const t of tiersAvailable) {
    if (core.length >= limits.minCandidates) break;
    take(pickFrom(pool.filter((p) => tierOf.get(p.m.slug) === t).sort((a, b) => b.score - a.score)));
  }
  // Fill the core with new creators first, in relevance order.
  const roundRobin: Scored[] = [];
  for (let i = 0; roundRobin.length < pool.length; i++) {
    let added = false;
    for (const c of creators) {
      const row = byCreator.get(c)![i];
      if (row) {
        roundRobin.push(row);
        added = true;
      }
    }
    if (!added) break;
  }
  while (core.length < Math.min(limits.minCandidates, pool.length)) take(pickFrom(roundRobin));
  // Cheapest core member runs first: it doubles as the paid screening run.
  core.sort((a, b) => a.worst - b.worst);

  const expansion = roundRobin.filter((r) => !core.includes(r));
  const queueLimit = limits.maxCandidates * 2; // room to skip and continue under the cap
  const queue = [...core, ...expansion].slice(0, queueLimit);
  if (pool.length > queue.length) count(excluded, "beyond_queue", pool.length - queue.length);

  const toCandidate = (p: Scored, rank: number, role: CandidateRole, tier: PriceTier): Candidate => ({
    model: p.m,
    access: p.access,
    maxOutputTokens: p.maxOut,
    worstCaseCostUsd: p.worst,
    expectedCostUsd: p.expected,
    relevance: Math.round(p.score * 1000) / 1000,
    rank,
    role,
    priceTier: tier,
    reason: [
      `${u.outputModality} output`,
      `${tier} price tier`,
      ...p.reasons,
      tier === "free" ? `free tier via ${p.access.providerId}` : `$${p.access.inputUsdPer1m}/$${p.access.outputUsdPer1m} per 1M via ${p.access.providerId}`,
    ].join("; "),
  });
  const candidates = queue.map((p, i) => toCandidate(p, i + 1, i < core.length ? "core" : "expansion", tierOf.get(p.m.slug)!));

  // Free screening: different families from each other, most relevant first.
  const screening =
    limits.freeScreeningModels > 0 && candidates.length >= 2
      ? dedupe(freeOptions.map(score), false)
          .sort((a, b) => b.score - a.score)
          .slice(0, limits.freeScreeningModels)
          .map((p, i) => toCandidate(p, i + 1, "free_screening", "free"))
      : [];

  const coreCands = candidates.filter((c) => c.role === "core");
  return {
    candidates,
    screening,
    considered: opts.registry.filter((m) => m.status === "active").length,
    capableInRegistry: capable.length,
    excluded,
    overUserBudget: overUserBudget.sort((a, b) => a.worstCaseCostUsd - b.worstCaseCostUsd),
    tiersAvailable,
    creatorsAvailable: creators.length,
    plannedOutputTokens: planned,
    outputBudgetBasis: budget.basis,
    estimatedExecutionCostUsd: coreCands.reduce((s, c) => s + c.expectedCostUsd, 0),
    worstCaseCoreUsd: coreCands.reduce((s, c) => s + c.worstCaseCostUsd, 0),
    executionBudgetUsd: limits.maxExecutionCostUsd,
    target: limits.maxCandidates,
  };
}
