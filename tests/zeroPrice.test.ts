import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessages } from "../lib/comparison/execute";
import { isLabelEligible, labelOutcomes, meaningfulness, runProgressive } from "../lib/comparison/progressive";
import { assignLabels } from "../lib/labels";
import { isFreeAccess, selectCandidates } from "../lib/selection/select";
import { understandTask } from "../lib/task/understand";
import type { ProviderAdapter, RunModelRequest } from "../lib/providers/types";
import { access, DEFAULT_LIMITS, model } from "./fixtures";

// Regression: OpenRouter lists some models (e.g. "stealth/space-bunny-alpha")
// at $0/$0 without a ":free" suffix. They used to be treated as paid, land in
// the paid core and take Cheaper cost at $0.
const TASK = "Write a 1,000-word article explaining why small businesses should care about AI agents.";
const u = understandTask({ task: TASK, useCase: "Long-form writing" });
const OR = new Set(["openrouter"]);
const ZERO = "stealth/space-bunny-alpha";
const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");

// 12 priced models over 6 creators, plus a $0/$0 route that is the most
// attractive model on every other signal (newest, reasoning, top benchmark).
function registry() {
  const creators = ["openai", "anthropic", "google", "deepseek", "qwen", "mistralai"];
  const reg = Array.from({ length: 12 }, (_, i) => {
    const price = [0.05, 0.1, 0.2, 0.4, 0.8, 1.2, 1.5, 2, 2.5, 3, 3.2, 3.5][i];
    return model(`${creators[i % 6]}/m${i}`, { price: [price / 4, price] });
  });
  reg.push(
    model(ZERO, {
      access: [access("openrouter", ZERO, 0, 0)],
      capabilities: ["reasoning", "text_generation"],
      releaseDate: "2026-09-30",
      benchmarks: { intelligence_index: 99 },
    })
  );
  return reg;
}

const select = (limits = DEFAULT_LIMITS) => selectCandidates({ registry: registry(), understanding: u, providers: OR, limits, taskText: TASK });

test("$0/$0 classification: a priced-at-zero route is free, with or without ':free'", () => {
  assert.equal(isFreeAccess(access("openrouter", ZERO, 0, 0)), true);
  assert.equal(isFreeAccess(access("openrouter", "x/y:free", 0, 0)), true);
  assert.equal(isFreeAccess(access("openrouter", "x/y", 0, 0.1)), false);
  assert.equal(isFreeAccess(access("openrouter", "x/y", 0.1, 0)), false);
  assert.equal(isFreeAccess(access("openrouter", "x/y", null, null)), false, "unknown price is not free");
  assert.equal(isFreeAccess({ ...access("openrouter", "x/y", 0, 0), requestUsd: 0.001 }), false, "a per-request fee is not free");
});

test("$0/$0 model never enters the paid core, expansion or queue; only free screening", () => {
  const s = select();
  assert.ok(s.candidates.length >= 4);
  assert.ok(!s.candidates.some((c) => c.model.slug === ZERO), "not in the paid queue");
  assert.ok(s.candidates.every((c) => c.worstCaseCostUsd > 0 && !isFreeAccess(c.access)));
  assert.ok(s.candidates.every((c) => c.role === "core" || c.role === "expansion"));
  assert.ok(!s.candidates.some((c) => c.priceTier === "free"));
  assert.equal(s.excluded.free_tier_only, 1);
  const zero = s.screening.find((c) => c.model.slug === ZERO);
  assert.ok(zero, "offered as free screening instead");
  assert.equal(zero!.role, "free_screening");
  assert.equal(zero!.priceTier, "free");
  // Tiers are computed from priced models only.
  assert.deepEqual(new Set(s.tiersAvailable), new Set(["low", "mid", "high"]));
});

test("a model with a priced route and a $0/$0 route runs paid on the priced route only", () => {
  const reg = [
    model("a/dual", { access: [access("openrouter", "a/dual", 0, 0), access("openai", "dual", 0.2, 0.8)] }),
    model("b/one"),
    model("c/two"),
  ];
  const s = selectCandidates({ registry: reg, understanding: u, providers: new Set(["openrouter", "openai"]), limits: DEFAULT_LIMITS, taskText: TASK });
  const dual = s.candidates.find((c) => c.model.slug === "a/dual")!;
  assert.equal(dual.access.providerId, "openai");
  assert.ok(dual.worstCaseCostUsd > 0);
});

test("zero execution budget: a $0/$0 route does not sneak through as a paid candidate", () => {
  const s = select({ ...DEFAULT_LIMITS, maxExecutionCostUsd: 0, maxCostPerCandidateUsd: 0 });
  assert.equal(s.candidates.length, 0);
});

function adapter() {
  const calls: RunModelRequest[] = [];
  const a: ProviderAdapter = {
    id: "openrouter",
    isConfigured: () => true,
    async run(req) {
      calls.push(req);
      // The $0 model "passes" with the shortest, cheapest answer of all.
      const text = req.externalModelId === ZERO ? words(900) : words(1000);
      return { ok: true, text, inputTokens: 30, outputTokens: 1400, totalTokens: 1430, latencyMs: 3, finishReason: "stop", providerReportedCostUsd: null, error: null, errorKind: null };
    },
  };
  return { a, calls };
}

test("end to end: the $0/$0 model runs only as screening, gets no label, and does not count as paid", async () => {
  const selection = select();
  const { a, calls } = adapter();
  const res = await runProgressive({ selection, messages: buildMessages(TASK), adapters: new Map([["openrouter", a]]), understanding: u, limits: DEFAULT_LIMITS });
  const zero = res.outcomes.find((o) => o.candidate.model.slug === ZERO);
  assert.ok(zero && calls.some((c) => c.externalModelId === ZERO), "it ran as screening");
  assert.equal(zero!.candidate.role, "free_screening");
  assert.equal(isLabelEligible(zero!), false);
  // Paid minimum is met by priced models alone.
  const paid = res.outcomes.filter(isLabelEligible);
  assert.equal(res.paidAttempted, paid.length);
  assert.ok(paid.length >= DEFAULT_LIMITS.minCandidates);
  assert.ok(paid.every((o) => o.candidate.worstCaseCostUsd > 0));
  // Neither label goes to it.
  const labels = labelOutcomes(res.outcomes, assignLabels);
  assert.ok(labels.cheaper.length > 0 && labels.better.length > 0);
  assert.ok(!labels.cheaper.includes(zero!.candidate.model.id), "no Cheaper cost");
  assert.ok(!labels.better.includes(zero!.candidate.model.id), "no Better cost");
  // Hard cap still holds.
  assert.ok(res.ledger.chargedUsd <= DEFAULT_LIMITS.maxExecutionCostUsd + 1e-12);
  assert.ok(res.ledger.peakCommittedUsd <= DEFAULT_LIMITS.maxExecutionCostUsd + 1e-12);
});

test("defense in depth: a $0/$0 route labeled 'core' is still never label-eligible or counted as paid", () => {
  const zeroAccess = access("openrouter", ZERO, 0, 0);
  const paidAccess = access("openrouter", "openai/m1", 0.1, 0.4);
  const o = (id: string, acc: typeof zeroAccess, cost: number, tier: string, creator: string) =>
    ({ candidate: { role: "core", priceTier: tier, access: acc, model: { id, name: id, creator } }, passed: true, estimatedCostUsd: cost, costPerSuccessUsd: cost, stage: 1 }) as any;
  const zero = o("zero", zeroAccess, 0, "low", "stealth");
  const one = o("paid", paidAccess, 0.001, "mid", "openai");
  assert.equal(isLabelEligible(zero), false);
  // One real paid run plus a $0 "core" run is fewer than two paid runs.
  const l = labelOutcomes([zero, one], assignLabels);
  assert.match(l.withheld!, /Fewer than two paid models/);
  assert.deepEqual(l.cheaper, []);
  assert.deepEqual(l.better, []);
  // And it does not count toward the paid minimum.
  const m = meaningfulness([zero, one, o("p2", paidAccess, 0.002, "high", "google"), o("p3", paidAccess, 0.003, "low", "qwen")], select(), 4);
  assert.equal(m.meaningful, false);
});
