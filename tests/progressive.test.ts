import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessages } from "../lib/comparison/execute";
import { labelOutcomes, meaningfulness, runProgressive, isLabelEligible } from "../lib/comparison/progressive";
import { assignLabels } from "../lib/labels";
import { worstCaseInputTokens } from "../lib/pricing";
import { selectCandidates } from "../lib/selection/select";
import { understandTask } from "../lib/task/understand";
import type { ProviderAdapter, RunModelRequest, RunModelResult } from "../lib/providers/types";
import type { ExecutionLimits } from "../lib/config";
import { access, DEFAULT_LIMITS, model } from "./fixtures";

const TASK = "Write a product update for our customers. Keep it under 100 words.";
const u = understandTask({ task: TASK, useCase: "writing" });
const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
const PASS = words(80);
const FAIL = words(150);

// 12 paid models over 6 creators across a price range, plus two free tiers.
function registry() {
  const creators = ["openai", "anthropic", "google", "deepseek", "qwen", "mistralai"];
  const reg = Array.from({ length: 12 }, (_, i) => {
    const c = creators[i % 6];
    const price = [0.05, 0.1, 0.2, 0.4, 0.8, 1.2, 2, 3, 4, 6, 8, 10][i];
    return model(`${c}/m${i}`, { price: [price / 4, price] });
  });
  reg.push(model("meta-llama/free-a", { access: [access("openrouter", "meta-llama/free-a:free", 0, 0)] }));
  reg.push(model("z-ai/free-b", { access: [access("openrouter", "z-ai/free-b:free", 0, 0)] }));
  return reg;
}

function plan(limits: ExecutionLimits = DEFAULT_LIMITS) {
  return selectCandidates({ registry: registry(), understanding: u, providers: new Set(["openrouter"]), limits, taskText: TASK });
}

type Behavior = (req: RunModelRequest) => Partial<RunModelResult> | Promise<Partial<RunModelResult>>;
function adapter(behavior: Behavior = () => ({ text: PASS })) {
  const calls: RunModelRequest[] = [];
  const a: ProviderAdapter = {
    id: "openrouter",
    isConfigured: () => true,
    async run(req) {
      calls.push(structuredClone(req));
      await new Promise((r) => setTimeout(r, 1 + Math.random() * 4));
      return { ok: true, text: PASS, inputTokens: 30, outputTokens: 110, totalTokens: 140, latencyMs: 3, finishReason: "stop", providerReportedCostUsd: null, error: null, errorKind: null, ...(await behavior(req)) };
    },
  };
  return { a, calls };
}

async function run(behavior?: Behavior, limits: ExecutionLimits = DEFAULT_LIMITS, selection = plan(limits)) {
  const { a, calls } = adapter(behavior);
  const res = await runProgressive({ selection, messages: buildMessages(TASK), adapters: new Map([["openrouter", a]]), understanding: u, limits });
  return { res, calls, selection };
}

test("progressive: stops after the core when the comparison is already meaningful", async () => {
  const { res, selection } = await run();
  assert.ok(selection.candidates.length >= 10);
  assert.equal(res.paidAttempted, DEFAULT_LIMITS.minCandidates); // 4, not 10
  assert.equal(res.meaningful, true);
  assert.match(res.stopReason, /Meaningful comparison reached/);
  assert.ok(res.skipped.filter((s) => s.kind === "meaningful").length >= 6);
  const tiers = new Set(res.outcomes.filter(isLabelEligible).map((o) => o.candidate.priceTier));
  assert.deepEqual(tiers, new Set(["low", "mid", "high"]), "low, mid and high tiers all ran");
});

test("progressive: keeps going while fewer than two pass, up to MAX_CANDIDATES_PER_RUN", async () => {
  const allFail = await run(() => ({ text: FAIL }));
  assert.equal(allFail.res.meaningful, false);
  assert.ok(allFail.res.paidAttempted > DEFAULT_LIMITS.minCandidates);
  assert.ok(allFail.res.paidAttempted <= DEFAULT_LIMITS.maxCandidates);

  let n = 0;
  const onePassInCore = await run(() => ({ text: n++ === 1 ? PASS : FAIL }));
  // one pass in the core is not enough; expansion continues
  assert.ok(onePassInCore.res.paidAttempted > DEFAULT_LIMITS.minCandidates);
});

test("meaningfulness requires every available price tier and three creators", () => {
  const sel = plan();
  const fake = (tier: string, creator: string, passed: boolean) =>
    ({ candidate: { role: "core", priceTier: tier, model: { creator } }, passed, stage: 1 }) as any;
  const missingHigh = [fake("low", "a", true), fake("low", "b", true), fake("mid", "c", true), fake("mid", "d", true)];
  assert.equal(meaningfulness(missingHigh, sel, 4).meaningful, false);
  assert.deepEqual(meaningfulness(missingHigh, sel, 4).missingTiers, ["high"]);
  const twoCreators = [fake("low", "a", true), fake("mid", "a", true), fake("high", "b", true), fake("high", "b", true)];
  assert.equal(meaningfulness(twoCreators, sel, 4).meaningful, false);
  const ok = [fake("low", "a", true), fake("mid", "b", false), fake("high", "c", true), fake("mid", "d", false)];
  assert.equal(meaningfulness(ok, sel, 4).meaningful, true);
});

test("hard spend cap: never exceeded even when every call bills its absolute worst case", async () => {
  for (const cap of [0.0002, 0.0007, 0.002, 0.03]) {
    const limits = { ...DEFAULT_LIMITS, maxExecutionCostUsd: cap, maxCostPerCandidateUsd: cap };
    const { res, calls } = await run((req) => ({ text: FAIL, inputTokens: worstCaseInputTokens(TASK), outputTokens: req.maxTokens }), limits);
    assert.ok(res.ledger.chargedUsd <= cap + 1e-12, `charged ${res.ledger.chargedUsd} > cap ${cap}`);
    assert.ok(res.ledger.peakCommittedUsd <= cap + 1e-12, `peak ${res.ledger.peakCommittedUsd} > cap ${cap}`);
    assert.equal(res.ledger.overruns.length, 0);
    assert.equal(calls.length, res.outcomes.length);
    if (cap < 0.03) assert.ok(res.skipped.some((s) => s.kind === "budget"), `cap ${cap}: expected budget skips`);
  }
});

test("timeouts are charged their worst case; an over-bound bill that breaks the cap stops further launches", async () => {
  const limits = { ...DEFAULT_LIMITS, maxConcurrent: 1 };
  const timed = await run(() => ({ ok: false, text: "", inputTokens: null, outputTokens: null, errorKind: "timeout", error: "timed out" }), limits);
  const worst = timed.res.outcomes.filter(isLabelEligible).reduce((s, o) => s + o.candidate.worstCaseCostUsd, 0);
  assert.equal(timed.res.ledger.actualUsd, 0);
  assert.ok(Math.abs(timed.res.ledger.chargedUsd - worst) < 1e-12);

  const over = await run(() => ({ inputTokens: 10_000_000, outputTokens: 10 }), limits);
  assert.ok(over.res.ledger.overruns.length >= 1);
  assert.match(over.res.stopReason, /^Stopped by cost control/);
  assert.ok(over.res.skipped.some((s) => s.kind === "budget"));
  const paidCalls = over.calls.filter((c) => !c.externalModelId.endsWith(":free"));
  assert.equal(paidCalls.length, 1, "no paid call launches once billing broke the cap");
});

test("zero budget: nothing runs and nothing is spent", async () => {
  const limits = { ...DEFAULT_LIMITS, maxExecutionCostUsd: 0, maxCostPerCandidateUsd: 0 };
  const { res, calls, selection } = await run(undefined, limits);
  assert.equal(selection.candidates.length, 0);
  assert.equal(calls.length, 0);
  assert.equal(res.ledger.chargedUsd, 0);
});

test("free screening runs first, costs nothing, and never gets a cost label", async () => {
  const { res, calls } = await run();
  const screening = res.outcomes.filter((o) => !isLabelEligible(o));
  assert.equal(screening.length, 2);
  assert.ok(screening.every((o) => o.stage === 0 && o.estimatedCostUsd === 0 && o.passed));
  assert.ok(calls.filter((c) => c.externalModelId.endsWith(":free")).length === 2);
  // $0 and passing, yet not Cheaper cost or Better cost.
  const labels = labelOutcomes(res.outcomes, assignLabels);
  const freeIds = screening.map((o) => o.candidate.model.id);
  assert.ok(labels.cheaper.every((id) => !freeIds.includes(id)));
  assert.ok(labels.better.every((id) => !freeIds.includes(id)));
  assert.ok(labels.cheaper.length > 0 && labels.better.length > 0);
  // Screening alone never ends a comparison: paid core still ran.
  assert.ok(res.paidAttempted >= DEFAULT_LIMITS.minCandidates);
});

test("every executed candidate, screening included, receives the exact task", async () => {
  const { calls } = await run();
  assert.ok(calls.length >= 6);
  for (const c of calls) assert.deepEqual(c.messages, [{ role: "user", content: TASK }]);
});

test("partial execution: provider errors cost nothing and the rest still compare", async () => {
  let i = 0;
  const { res } = await run(() => (i++ % 3 === 1 ? { ok: false, text: "", inputTokens: null, outputTokens: null, error: "upstream 502", errorKind: "provider_error" } : { text: PASS }));
  const errors = res.outcomes.filter((o) => !o.run.ok);
  assert.ok(errors.length > 0);
  assert.ok(errors.every((o) => o.estimatedCostUsd === null && o.costPerSuccessUsd === null));
  const known = res.outcomes.reduce((s, o) => s + (o.estimatedCostUsd ?? 0), 0);
  assert.ok(Math.abs(res.ledger.actualUsd - known) < 1e-15);
  assert.ok(res.outcomes.filter((o) => isLabelEligible(o) && o.passed).length >= 2);
});

test("diversity: executed paid models span at least three creators", async () => {
  const { res } = await run();
  const creators = new Set(res.outcomes.filter(isLabelEligible).map((o) => o.candidate.model.creator));
  assert.ok(creators.size >= 3);
});

test("Cheaper cost: lowest measured dollars among paid runs, pass or fail", async () => {
  const { res } = await run((req) => ({ text: req.externalModelId.includes("m0") ? FAIL : PASS }));
  const labels = labelOutcomes(res.outcomes, assignLabels);
  const paid = res.outcomes.filter(isLabelEligible).filter((o) => o.estimatedCostUsd !== null);
  const min = Math.min(...paid.map((o) => o.estimatedCostUsd!));
  const expected = paid.filter((o) => o.estimatedCostUsd === min).map((o) => o.candidate.model.id).sort();
  assert.deepEqual([...labels.cheaper].sort(), expected);
  const cheapest = paid.find((o) => o.estimatedCostUsd === min)!;
  assert.equal(cheapest.passed, false, "the cheapest run failed and still holds Cheaper cost");
});

test("Better cost: lowest $/success among passing paid runs; a fail never gets it", async () => {
  const { res } = await run((req) => ({ text: req.externalModelId.includes("m0") ? FAIL : PASS }));
  const labels = labelOutcomes(res.outcomes, assignLabels);
  const passed = res.outcomes.filter((o) => isLabelEligible(o) && o.passed);
  const min = Math.min(...passed.map((o) => o.costPerSuccessUsd!));
  assert.deepEqual([...labels.better].sort(), passed.filter((o) => o.costPerSuccessUsd === min).map((o) => o.candidate.model.id).sort());
  for (const id of labels.better) assert.ok(passed.some((o) => o.candidate.model.id === id));
  // Nobody passes: no Better cost at all.
  const none = await run(() => ({ text: FAIL }));
  assert.deepEqual(labelOutcomes(none.res.outcomes, assignLabels).better, []);
});

test("labels are withheld when fewer than two paid models ran", () => {
  const one = [{ candidate: { role: "core", model: { id: "x", name: "x" } }, passed: true, estimatedCostUsd: 0.001, costPerSuccessUsd: 0.001 }] as any;
  const screeningOnly = [{ candidate: { role: "free_screening", model: { id: "f", name: "f" } }, passed: true, estimatedCostUsd: 0, costPerSuccessUsd: 0 }] as any;
  assert.match(labelOutcomes(one, assignLabels).withheld!, /Fewer than two/);
  assert.deepEqual(labelOutcomes([...one, ...screeningOnly], assignLabels).cheaper, []);
});
