// Candidate selection: which registry models run this task.
//
// 1. Capability filter  output modality, text input, context window, output length
// 2. Access filter      a configured provider serves it at a known price
// 3. Budget filter      user's per-task budget, then Realizah's execution budget
// 4. Relevance          task-relevant benchmark signal, task-relevant verified
//                       capabilities, freshness (signals, never proof)
// 5. Diversity          round-robin across creators with a per-creator cap,
//                       plus a share of slots for the cheapest capable models
//
// Pure: no database, no env, no network.
import type { ExecutionLimits } from "../config";
import { worstCaseCostUsd } from "../pricing";
import type { RegistryAccess, RegistryModel } from "../registry/types";
import { outputTokensFor, plannedOutputTokens } from "../task/outputBudget";
import type { TaskUnderstanding } from "../task/understand";

export type Candidate = {
  model: RegistryModel;
  access: RegistryAccess;
  maxOutputTokens: number;
  worstCaseCostUsd: number;
  relevance: number;
  rank: number;
  reason: string;
};

export type ExclusionReason =
  | "wrong_modality"
  | "context_too_small"
  | "output_limit_too_small"
  | "no_configured_provider"
  | "price_unknown"
  | "near_duplicate"
  | "exceeds_user_budget"
  | "exceeds_execution_budget"
  | "over_target";

export type SelectionResult = {
  candidates: Candidate[];
  // Capable of the task regardless of which providers we hold keys for.
  capableInRegistry: number;
  excluded: Partial<Record<ExclusionReason, number>>;
  overUserBudget: { slug: string; worstCaseCostUsd: number }[];
  estimatedExecutionCostUsd: number;
  executionBudgetUsd: number;
  plannedOutputTokens: number;
  target: number;
};

const BENCHMARK_FOR: Record<string, string> = {
  coding: "coding_index",
  mathematics: "math_index",
};
const REASONING_TASKS = new Set(["reasoning", "mathematics", "analysis", "coding", "research"]);

function isFree(a: RegistryAccess) {
  return a.externalModelId.endsWith(":free");
}

// "openai/gpt-4o-mini-2024-07-18" and "openai/gpt-4o-mini" are the same
// family; variants like ":thinking" or ":beta" too. One per family.
export function familyKey(slug: string): string {
  return slug
    .replace(/:[a-z-]+$/i, "")
    .replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8}|\d{4}|\d{2}-\d{2})$/i, "")
    .replace(/-(?:preview|latest|exp|experimental)$/i, "")
    .toLowerCase();
}

function addCount(e: SelectionResult["excluded"], r: ExclusionReason, n = 1) {
  e[r] = (e[r] ?? 0) + n;
}

export function selectCandidates(opts: {
  registry: RegistryModel[];
  understanding: TaskUnderstanding;
  providers: ReadonlySet<string>;
  limits: ExecutionLimits;
  userBudgetUsd?: number | null;
  now?: Date;
}): SelectionResult {
  const { understanding: u, limits } = opts;
  const now = opts.now ?? new Date();
  const target = limits.maxCandidates;
  const excluded: SelectionResult["excluded"] = {};
  const planned = plannedOutputTokens(u, limits);
  const inputTokens = u.constraints.estimatedInputTokens + 16;

  // 1. Capability.
  const capable: { m: RegistryModel; maxOut: number }[] = [];
  for (const m of opts.registry) {
    if (m.status !== "active") continue;
    if (!m.outputModalities.includes(u.outputModality) || !m.inputModalities.includes("text")) {
      addCount(excluded, "wrong_modality");
      continue;
    }
    const reasoning = m.capabilities.includes("reasoning");
    const maxOut = outputTokensFor(reasoning, planned, limits, m.maxOutputTokens);
    if (m.maxOutputTokens !== null && m.maxOutputTokens < Math.min(planned, limits.maxOutputTokens)) {
      addCount(excluded, "output_limit_too_small");
      continue;
    }
    if (m.contextWindow !== null && m.contextWindow < inputTokens + maxOut) {
      addCount(excluded, "context_too_small");
      continue;
    }
    capable.push({ m, maxOut });
  }

  // 2. Access: cheapest priced path through a configured provider.
  type Priced = { m: RegistryModel; access: RegistryAccess; maxOut: number; worst: number };
  const priced: Priced[] = [];
  for (const { m, maxOut } of capable) {
    const reachable = m.access.filter((a) => opts.providers.has(a.providerId) && !isFree(a));
    if (!reachable.length) {
      addCount(excluded, "no_configured_provider");
      continue;
    }
    let best: Priced | null = null;
    for (const a of reachable) {
      const worst = worstCaseCostUsd(inputTokens, maxOut, a);
      if (worst === null || a.priceStatus === "unknown") continue;
      const better =
        !best || worst < best.worst - 1e-12 || (Math.abs(worst - best.worst) <= 1e-12 && best.access.providerId === "openrouter" && a.providerId !== "openrouter");
      if (better) best = { m, access: a, maxOut, worst };
    }
    if (!best) {
      addCount(excluded, "price_unknown");
      continue;
    }
    priced.push(best);
  }

  // 3a. User budget: can't afford even one task at worst case.
  const overUserBudget: SelectionResult["overUserBudget"] = [];
  let affordable = priced;
  if (opts.userBudgetUsd !== undefined && opts.userBudgetUsd !== null) {
    affordable = priced.filter((p) => {
      if (p.worst <= opts.userBudgetUsd!) return true;
      overUserBudget.push({ slug: p.m.slug, worstCaseCostUsd: p.worst });
      addCount(excluded, "exceeds_user_budget");
      return false;
    });
  }

  // 4. Relevance (signals only).
  const metric = BENCHMARK_FOR[u.primary] ?? "intelligence_index";
  const maxBench = Math.max(0, ...affordable.map((p) => p.m.benchmarks[metric] ?? 0));
  const scored = affordable.map((p) => {
    const reasons: string[] = [];
    let score = 0.3;
    const b = p.m.benchmarks[metric];
    if (b !== undefined && maxBench > 0) {
      score += 0.4 * (b / maxBench);
      reasons.push(`${metric.replace(/_/g, " ")} ${Math.round(b * 10) / 10}`);
    } else {
      score += 0.15;
    }
    const caps = new Set(p.m.capabilities);
    if (REASONING_TASKS.has(u.primary) && caps.has("reasoning")) {
      score += 0.15;
      reasons.push("reasoning");
    }
    if ((u.primary === "structured_json" || u.constraints.outputFormat === "json") && caps.has("structured_output")) {
      score += 0.15;
      reasons.push("structured output");
    }
    if (p.m.releaseDate) {
      const ageDays = (now.getTime() - new Date(p.m.releaseDate).getTime()) / 86_400_000;
      if (ageDays <= 365) score += 0.1;
      else if (ageDays <= 730) score += 0.05;
    }
    return { ...p, score, reasons };
  });

  // Near-duplicates: keep the most relevant member of each family.
  const byFamily = new Map<string, (typeof scored)[number]>();
  for (const s of scored) {
    const k = familyKey(s.m.slug);
    const prev = byFamily.get(k);
    if (!prev || s.score > prev.score || (s.score === prev.score && (s.m.releaseDate ?? "") > (prev.m.releaseDate ?? ""))) {
      if (prev) addCount(excluded, "near_duplicate");
      byFamily.set(k, s);
    } else {
      addCount(excluded, "near_duplicate");
    }
  }
  const pool = [...byFamily.values()];

  // 5. Diversity: round-robin across creators, then reserve slots for the
  // cheapest capable models so the price range is represented.
  const byCreator = new Map<string, typeof pool>();
  for (const p of pool) {
    const list = byCreator.get(p.m.creator) ?? [];
    list.push(p);
    byCreator.set(p.m.creator, list);
  }
  for (const list of byCreator.values()) list.sort((a, b) => b.score - a.score || a.worst - b.worst);
  const creators = [...byCreator.entries()].sort((a, b) => b[1][0].score - a[1][0].score).map(([c]) => c);
  const perCreatorCap = Math.max(2, Math.ceil(target / Math.max(1, creators.length)));

  const ordered: typeof pool = [];
  const taken = new Set<string>();
  const perCreator = new Map<string, number>();
  const take = (p: (typeof pool)[number], cap: number) => {
    if (taken.has(p.m.slug) || (perCreator.get(p.m.creator) ?? 0) >= cap) return false;
    taken.add(p.m.slug);
    perCreator.set(p.m.creator, (perCreator.get(p.m.creator) ?? 0) + 1);
    ordered.push(p);
    return true;
  };
  const roundRobin = (limit: number, cap: number) => {
    let progress = true;
    while (ordered.length < limit && progress) {
      progress = false;
      for (const c of creators) {
        if (ordered.length >= limit) break;
        const next = byCreator.get(c)!.find((p) => !taken.has(p.m.slug));
        if (next && take(next, cap)) progress = true;
      }
    }
  };
  const relevanceSlots = Math.ceil(target * 0.75);
  roundRobin(relevanceSlots, perCreatorCap);
  for (const p of [...pool].sort((a, b) => a.worst - b.worst)) {
    if (ordered.length >= target) break;
    take(p, perCreatorCap + 1);
  }
  roundRobin(pool.length, pool.length); // leftovers, in case the budget skips some

  // 3b. Realizah's own execution budget, in the order above.
  const candidates: Candidate[] = [];
  let spend = 0;
  for (const p of ordered) {
    if (candidates.length >= target) {
      addCount(excluded, "over_target");
      continue;
    }
    if (spend + p.worst > limits.maxExecutionCostUsd) {
      addCount(excluded, "exceeds_execution_budget");
      continue;
    }
    spend += p.worst;
    const price = `$${p.access.inputUsdPer1m}/$${p.access.outputUsdPer1m} per 1M via ${p.access.providerId}`;
    candidates.push({
      model: p.m,
      access: p.access,
      maxOutputTokens: p.maxOut,
      worstCaseCostUsd: p.worst,
      relevance: Math.round(p.score * 1000) / 1000,
      rank: candidates.length + 1,
      reason: [`${u.outputModality} output`, ...p.reasons, price].join("; "),
    });
  }

  return {
    candidates,
    capableInRegistry: capable.length,
    excluded,
    overUserBudget: overUserBudget.sort((a, b) => a.worstCaseCostUsd - b.worstCaseCostUsd),
    estimatedExecutionCostUsd: spend,
    executionBudgetUsd: limits.maxExecutionCostUsd,
    plannedOutputTokens: planned,
    target,
  };
}
